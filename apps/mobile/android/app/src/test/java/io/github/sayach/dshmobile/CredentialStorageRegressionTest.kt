package io.github.sayach.dshmobile

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.*
import org.junit.Test

private class MemoryCredentialPreferences : CredentialPreferences {
    val strings = linkedMapOf<String, String>()
    val flags = linkedMapOf<String, Boolean>()
    override fun string(key: String): String? = strings[key]
    override fun boolean(key: String): Boolean = flags[key] ?: false
    override fun write(strings: Map<String, String>, booleans: Map<String, Boolean>) { this.strings.putAll(strings); flags.putAll(booleans) }
    override fun clear() { strings.clear(); flags.clear() }
}

/** Actual AES/GCM ciphertext with controllable Keystore-unavailability behavior. */
private class JvmCredentialEncryption : CredentialEncryption {
    private val keys = mutableMapOf<String, SecretKey>()
    var failDecrypt = false
    var failNextDecrypt = false
    var failEncrypt = false
    var writes = 0
    override fun decrypt(payload: String, iv: String, alias: String): String {
        if (failDecrypt || failNextDecrypt) { failNextDecrypt = false; throw CredentialStorageUnavailable() }
        val key = keys[alias] ?: throw CredentialStorageUnavailable()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.getDecoder().decode(iv)))
        return String(cipher.doFinal(Base64.getDecoder().decode(payload)), Charsets.UTF_8)
    }
    override fun encrypt(plaintext: String, alias: String, allowNewKey: Boolean): EncryptedCredential {
        if (failEncrypt) throw CredentialStorageUnavailable()
        val key = keys[alias] ?: if (allowNewKey) SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(alias.toByteArray()), "AES").also { keys[alias] = it } else throw CredentialStorageUnavailable()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        writes++
        return EncryptedCredential(Base64.getEncoder().encodeToString(cipher.doFinal(plaintext.toByteArray())), Base64.getEncoder().encodeToString(cipher.iv))
    }
    override fun deleteKey(alias: String) { keys.remove(alias) }
}

class CredentialStorageRegressionTest {
    private fun record(seed: Char = 'a', name: String = "Saved computer") = PairedDeviceRecord(
        instanceId = seed.toString().repeat(64), deviceId = "", displayName = name, mode = AccessMode.REMOTE,
        origin = GatewayOrigin.parse("https://computer.example")!!, deviceToken = "T".repeat(43),
        expiresAt = 9999999999999L, caCertificate = null, lastConnectedAt = 10L, lastReachableAt = 10L,
        status = PairedDeviceStatus.REACHABLE,
    )

    @Test fun absentAndUnreadableAreDifferentAndCiphertextDoesNotExposeTokens() {
        val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
        assertEquals(CredentialRead.Absent, store.read())
        store.upsert(record())
        assertEquals(listOf(record()), store.load())
        assertFalse(preferences.strings.getValue("payload").contains(record().deviceToken))
        crypto.failDecrypt = true
        assertEquals(CredentialRead.Unreadable, store.read())
        assertTrue(store.storageUnavailable)
    }

    @Test fun everyMutationRetainsCiphertextAndIvWhileKeystoreIsUnreadable() {
        val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
        val original = listOf(record('a'), record('b', "Other computer"))
        original.forEach(store::upsert)
        val saved = preferences.strings.toMap(); val flags = preferences.flags.toMap(); val writes = crypto.writes
        crypto.failDecrypt = true
        val mutations: List<() -> Unit> = listOf(
            { store.upsert(record('c')) }, { store.update(original[0].key) { it.copy(displayName = "Changed") } },
            { store.remove(original[0].key) }, { store.moveUp(original[1].key) }, { store.moveToTop(original[1].key) },
            { store.migrateLegacy(emptyList()) },
        )
        mutations.forEach { mutation ->
            assertThrows(CredentialStorageUnavailable::class.java) { mutation() }
            assertEquals(saved, preferences.strings); assertEquals(flags, preferences.flags); assertEquals(writes, crypto.writes)
        }
        crypto.failDecrypt = false
        assertEquals(original, store.load())
        assertFalse(store.storageUnavailable)
    }

    @Test fun aSingleFailedReadCannotBecomeAnEmptyOverwriteWhenTheKeyImmediatelyRecovers() {
        val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
        store.upsert(record())
        val before = preferences.strings.toMap()
        crypto.failNextDecrypt = true
        assertThrows(CredentialStorageUnavailable::class.java) { store.upsert(record('b')) }
        assertEquals(before, preferences.strings)
        assertEquals(listOf(record()), store.load())
        store.upsert(record('b'))
        assertEquals(listOf(record(), record('b')), store.load())
    }

    @Test fun aWriteFailureRetainsTheLastCompletePayload() {
        val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
        store.upsert(record())
        val before = preferences.strings.toMap()
        crypto.failEncrypt = true
        assertThrows(CredentialStorageUnavailable::class.java) { store.upsert(record('b')) }
        assertEquals(before, preferences.strings)
        crypto.failEncrypt = false
        assertEquals(listOf(record()), store.load())
    }

    @Test fun corruptOrPartlyUnknownRecordsAreNotSilentlyDroppedDuringAMutation() {
        val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
        store.upsert(record())
        val json = crypto.decrypt(preferences.strings.getValue("payload"), preferences.strings.getValue("iv"), "dsh_mobile_devices_v1")
        val malformed = crypto.encrypt(json.dropLast(1) + ",{\"version\":99}]", "dsh_mobile_devices_v1", false)
        preferences.write(mapOf("payload" to malformed.payload, "iv" to malformed.iv))
        val before = preferences.strings.toMap()
        assertEquals(CredentialRead.Unreadable, store.read())
        assertThrows(CredentialStorageUnavailable::class.java) { store.upsert(record('b')) }
        assertEquals(before, preferences.strings)
    }

    @Test fun unreadableLegacySlotsDoNotCompleteMigrationOrReplaceTheirOldCiphertext() {
        val preferences = MemoryCredentialPreferences(); val old = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption()
        val store = PairedDeviceStore(preferences, crypto); val legacy = DeviceCredentialStore(old, crypto, "remote")
        val credential = DeviceCredential(record().instanceId, record().deviceToken, record().expiresAt, null)
        legacy.save(credential)
        val original = old.strings.toMap()
        crypto.failDecrypt = true
        val slots = listOf(LegacyDeviceSlot(AccessMode.REMOTE, record().origin, legacy.read(), "Legacy", 1L))
        assertThrows(CredentialStorageUnavailable::class.java) { migrateLegacyPairedDevices(store, slots, 100L) }
        assertFalse(store.isMigrationComplete()); assertTrue(preferences.strings.isEmpty()); assertEquals(original, old.strings)
        assertThrows(CredentialStorageUnavailable::class.java) { legacy.save(credential.copy(deviceToken = "N".repeat(43))) }
        assertEquals(original, old.strings)
        crypto.failDecrypt = false
        migrateLegacyPairedDevices(store, slots.map { it.copy(credential = legacy.read()) }, 100L)
        assertTrue(store.isMigrationComplete())
        assertEquals(credential.deviceToken, store.load().single().deviceToken)
        assertEquals(original, old.strings)
    }

    @Test fun migrationRetryMergesMissingRowsWithoutResettingNewNamesTokensOrOrder() {
        val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
        val existing = record('a', "Custom new name").copy(deviceToken = "N".repeat(43))
        store.upsert(existing); store.upsert(record('b'))
        val legacy = DeviceCredential(existing.instanceId, "O".repeat(43), existing.expiresAt, null)
        migrateLegacyPairedDevices(store, listOf(LegacyDeviceSlot(AccessMode.REMOTE, existing.origin, CredentialRead.Loaded(legacy), "Legacy name", 30L)), 100L)
        assertTrue(store.isMigrationComplete())
        assertEquals(listOf(existing, record('b')), store.load())
    }

    @Test fun anEmptyMigrationCompletesOnlyForActuallyAbsentSlots() {
        val preferences = MemoryCredentialPreferences(); val store = PairedDeviceStore(preferences, JvmCredentialEncryption())
        migrateLegacyPairedDevices(store, listOf(LegacyDeviceSlot(AccessMode.LAN, null, CredentialRead.Absent, "LAN", null)), 100L)
        assertTrue(store.isMigrationComplete()); assertTrue(store.load().isEmpty())
    }

    @Test fun failedPreferenceCommitsRetainDecryptableRowsAndAllMigrationMarkers() {
        for (failure in listOf(FailingSharedPreferences.CommitOutcome.FALSE, FailingSharedPreferences.CommitOutcome.THROW)) {
            val preferences = FailingSharedPreferences(); val crypto = JvmCredentialEncryption()
            val store = PairedDeviceStore(AndroidCredentialPreferences(preferences), crypto)
            store.migrateLegacy(listOf(record()))
            val before = preferences.values.toMap()
            preferences.commitOutcomes.add(failure)
            assertThrows(CredentialStorageUnavailable::class.java) { store.upsert(record('b')) }
            assertEquals(before, preferences.values); assertEquals(before, preferences.persisted)
            assertEquals(listOf(record()), store.load()); assertTrue(store.isMigrationComplete())
            store.upsert(record('b'))
            assertEquals(listOf(record(), record('b')), store.load())
        }
    }

    @Test fun failedClearKeepsTheEncryptionKeyAndPreviouslyReadableRows() {
        val preferences = FailingSharedPreferences(); val crypto = JvmCredentialEncryption()
        val store = PairedDeviceStore(AndroidCredentialPreferences(preferences), crypto)
        store.migrateLegacy(listOf(record()))
        val before = preferences.values.toMap()
        preferences.commitOutcomes.add(FailingSharedPreferences.CommitOutcome.FALSE)
        assertThrows(CredentialStorageUnavailable::class.java) { store.clear() }
        assertEquals(before, preferences.values)
        assertEquals(listOf(record()), store.load()); assertTrue(store.isMigrationComplete())
    }

    @Test fun failedLegacySaveAndSharedAliasRewriteRetainThePreviousDecryptableCredential() {
        val preferences = FailingSharedPreferences(); val crypto = JvmCredentialEncryption()
        val store = DeviceCredentialStore(AndroidCredentialPreferences(preferences), crypto, "remote")
        val credential = DeviceCredential(record().instanceId, record().deviceToken, record().expiresAt, null)
        store.save(credential)
        val before = preferences.values.toMap()
        preferences.commitOutcomes.add(FailingSharedPreferences.CommitOutcome.THROW)
        assertThrows(CredentialStorageUnavailable::class.java) { store.save(credential.copy(deviceToken = "N".repeat(43))) }
        assertEquals(before, preferences.values); assertEquals(CredentialRead.Loaded(credential), store.read())

        val sharedAlias = crypto.encrypt("${credential.instanceId}\n${credential.deviceToken}\n${credential.expiresAt}\n-", "dsh_mobile_device_v1", true)
        assertTrue(preferences.edit().putString("credential", sharedAlias.payload).putString("iv", sharedAlias.iv).commit())
        val oldAliasBytes = preferences.values.toMap()
        preferences.commitOutcomes.add(FailingSharedPreferences.CommitOutcome.FALSE)
        assertEquals(CredentialRead.Loaded(credential), store.read())
        assertEquals(oldAliasBytes, preferences.values); assertEquals(oldAliasBytes, preferences.persisted)
        assertEquals(CredentialRead.Loaded(credential), store.read())
        assertNotEquals(oldAliasBytes, preferences.values)
    }

    @Test fun missingKeysAndTamperedGcmCiphertextCannotCreateReplacementRows() {
        for (removeKey in listOf(false, true)) {
            val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
            store.upsert(record())
            if (removeKey) crypto.deleteKey("dsh_mobile_devices_v1") else {
                val bytes = Base64.getDecoder().decode(preferences.strings.getValue("payload"))
                bytes[0] = (bytes[0].toInt() xor 1).toByte()
                preferences.strings["payload"] = Base64.getEncoder().encodeToString(bytes)
            }
            val before = preferences.strings.toMap(); val writes = crypto.writes
            assertEquals(CredentialRead.Unreadable, store.read())
            assertThrows(CredentialStorageUnavailable::class.java) { store.upsert(record('b')) }
            assertEquals(before, preferences.strings); assertEquals(writes, crypto.writes)
        }
    }

    @Test fun failedEmptyMarkersDoNotCompleteLegacyOrDisplayOrderMigration() {
        val preferences = FailingSharedPreferences(); val store = PairedDeviceStore(AndroidCredentialPreferences(preferences), JvmCredentialEncryption())
        preferences.commitOutcomes.add(FailingSharedPreferences.CommitOutcome.FALSE)
        assertThrows(CredentialStorageUnavailable::class.java) { store.migrateLegacy(emptyList()) }
        assertTrue(preferences.values.isEmpty()); assertFalse(store.isMigrationComplete())
        preferences.commitOutcomes.add(FailingSharedPreferences.CommitOutcome.THROW)
        assertTrue(store.load().isEmpty()); assertTrue(store.storageUnavailable)
        assertTrue(preferences.values.isEmpty()); assertFalse(store.isMigrationComplete())
        store.migrateLegacy(emptyList())
        assertTrue(store.isMigrationComplete())
    }

    @Test fun wrongTypedPayloadIvAndMarkersAreUnreadableWithoutMutatingPreferences() {
        for (key in listOf("payload", "iv", "legacy_migrated", "display_order_migrated_v1")) {
            val preferences = FailingSharedPreferences(mapOf(key to 17))
            val store = PairedDeviceStore(AndroidCredentialPreferences(preferences), JvmCredentialEncryption())
            val before = preferences.values.toMap()
            assertEquals(CredentialRead.Unreadable, store.read())
            assertTrue(store.load().isEmpty()); assertTrue(store.storageUnavailable)
            assertThrows(CredentialStorageUnavailable::class.java) { store.upsert(record()) }
            assertEquals(before, preferences.values); assertEquals(0, preferences.commits)
        }
        for (key in listOf("credential", "iv")) {
            val preferences = FailingSharedPreferences(mapOf(key to false))
            val store = DeviceCredentialStore(AndroidCredentialPreferences(preferences), JvmCredentialEncryption(), "remote")
            assertEquals(CredentialRead.Unreadable, store.read())
            assertThrows(CredentialStorageUnavailable::class.java) {
                store.save(DeviceCredential(record().instanceId, record().deviceToken, record().expiresAt, null))
            }
            assertEquals(mapOf(key to false), preferences.values); assertEquals(0, preferences.commits)
        }
    }

    @Test fun completedMigrationFencesLegacyRestoreAfterDeletingTheLastModernRow() {
        val preferences = MemoryCredentialPreferences(); val old = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption()
        val store = PairedDeviceStore(preferences, crypto); val legacy = DeviceCredentialStore(old, crypto, "remote")
        val credential = DeviceCredential(record().instanceId, record().deviceToken, record().expiresAt, null)
        legacy.save(credential)
        store.migrateLegacy(listOf(record()))
        assertTrue(store.remove(record().key)); assertTrue(store.load().isEmpty())
        crypto.failDecrypt = true
        assertEquals(CredentialRead.Unreadable, legacy.read())
        assertEquals(CredentialRead.Absent, readLegacyCredentialForRestore(store) { legacy.read() })
        crypto.failDecrypt = false
        assertEquals(CredentialRead.Loaded(credential), legacy.read())
        var legacyReads = 0
        assertEquals(CredentialRead.Absent, readLegacyCredentialForRestore(store) { legacyReads++; legacy.read() })
        assertEquals(0, legacyReads); assertTrue(store.load().isEmpty())
    }

    @Test fun sixtyFifthDeviceIsRejectedWithoutChangingTheExistingEncryptedList() {
        val preferences = MemoryCredentialPreferences(); val crypto = JvmCredentialEncryption(); val store = PairedDeviceStore(preferences, crypto)
        val records = (0 until 64).map { record().copy(instanceId = it.toString(16).padStart(64, '0')) }
        store.migrateLegacy(records)
        val before = preferences.strings.toMap(); val flags = preferences.flags.toMap(); val writes = crypto.writes
        assertThrows(CredentialStorageUnavailable::class.java) { store.upsert(record().copy(instanceId = "f".repeat(64))) }
        assertEquals(before, preferences.strings); assertEquals(flags, preferences.flags); assertEquals(writes, crypto.writes)
        assertEquals(records, store.load())
    }
}
