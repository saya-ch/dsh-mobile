package io.github.sayach.dshmobile

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Source checks cover the real preference/Keystore wiring not executable in keyless JVM tests. */
class PairedDeviceStoreMigrationWiringTest {
    @Test
    fun loadPersistsDisplayOrderAndItsMarkerInTheSameEncryptedWrite() {
        val store = sourceFile("java/io/github/sayach/dshmobile/PairedDeviceStore.kt").readText()
        val load = store.substringAfter("fun load()").substringBefore("fun isMigrationComplete")
        assertTrue(load.contains("PairedDeviceOrderPolicy.initialOrder("))
        assertTrue(load.contains("preferences.boolean(DISPLAY_ORDER_MIGRATION_KEY)"))
        assertTrue(load.contains("save(initial.rows)"))
        assertTrue(load.contains("preferences.write(booleans = mapOf(DISPLAY_ORDER_MIGRATION_KEY to true))"))
        val save = store.substringAfter("private fun save(").substringBefore("private fun decode(")
        assertEquals(1, Regex("preferences[.]write[(]").findAll(save).count())
        assertTrue(save.contains("PAYLOAD_KEY to encrypted.payload"))
        assertTrue(save.contains("IV_KEY to encrypted.iv"))
        assertTrue(save.contains("DISPLAY_ORDER_MIGRATION_KEY to true"))
        assertTrue(save.contains("MIGRATION_KEY to true"))
        assertFalse(save.contains("if (completeDisplayOrderMigration)"))
    }

    @Test
    fun emptyLegacyMigrationDoesNotConstructACipherAndDecodeFailureIsNotAnEmptyStore() {
        val store = sourceFile("java/io/github/sayach/dshmobile/PairedDeviceStore.kt").readText()
        val migration = store.substringAfter("fun migrateLegacy(").substringBefore("fun upsert(")
        val empty = migration.substringAfter("if (normalized.isEmpty())").substringBefore("} else {")
        assertFalse(empty.contains("save("))
        assertFalse(empty.contains("key()"))
        assertTrue(empty.contains("preferences.write(booleans"))
        assertTrue(migration.contains("val existing = rowsForMutation()"))
        assertTrue(migration.contains("val combined = existing + rows.filter"))
        val decode = store.substringAfter("private fun decode(").substringBefore("private fun parse(")
        assertTrue(decode.contains("List<PairedDeviceRecord>?"))
        assertTrue(decode.contains("if (payload.isNullOrBlank() || iv.isNullOrBlank()) return null"))
        assertTrue(decode.contains("encryption.decrypt(payload, iv, KEY_ALIAS)"))
        assertTrue(store.contains("CredentialRead.Unreadable -> throw CredentialStorageUnavailable()"))
    }

    @Test
    fun orderingActionsStayBeforeDeleteAndExistInAllThreeLocales() {
        val activity = sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()
        val actions = activity.substringAfter("private fun showDeviceActions").substringBefore("private fun editDeviceName")
        assertTrue(actions.contains("PairedDeviceOrderPolicy.canMoveUp"))
        assertTrue(actions.contains("PairedDeviceOrderPolicy.canMoveToTop"))
        assertTrue(actions.indexOf("device_action_move_up") < actions.indexOf("device_action_delete"))
        assertTrue(actions.indexOf("device_action_move_top") < actions.indexOf("device_action_delete"))
        for (locale in listOf("values", "values-zh-rCN", "values-it")) {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(sourceFile("res/$locale/strings.xml"))
            val strings = doc.getElementsByTagName("string")
            val names = (0 until strings.length).map { strings.item(it).attributes.getNamedItem("name").nodeValue }
            assertEquals(1, names.count { it == "device_action_move_up" })
            assertEquals(1, names.count { it == "device_action_move_top" })
        }
    }

    @Test
    fun automaticRestoreUsesTheLegacyMigrationFenceAndFullResetKeepsItUntilLegacyClearSucceeds() {
        val activity = sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()
        val automatic = activity.substringAfter("private fun recoverAutomatically()").substringBefore("private fun scheduleAutomaticRecovery()")
        assertTrue(automatic.contains("legacyCredentialForRestore(mode)"))
        assertTrue(automatic.contains("legacyCredentialForRestore()?.expiresAt"))
        assertFalse(automatic.contains("credentialStore(mode).load()"))
        assertFalse(automatic.contains("credentialStore().load()"))
        val reset = activity.substringAfter("private fun clearSiteData()").substringBefore("private fun shareGateway(")
        assertTrue(reset.contains("withCredentialStorage"))
        assertTrue(reset.indexOf("lanCredentialStore.clear()") < reset.indexOf("pairedDeviceStore.clear()"))
        assertTrue(reset.indexOf("remoteCredentialStore.clear()") < reset.indexOf("pairedDeviceStore.clear()"))
        assertTrue(reset.indexOf("pairedDeviceStore.clear()") < reset.indexOf("WebStorage.getInstance().deleteAllData()"))
        assertTrue(reset.contains("} == null) return"))
    }

    private fun sourceFile(path: String): File {
        val directories = listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main")
        return generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base -> directories.asSequence().map { File(base, "$it/$path") } }
            .first { it.isFile }
    }
}
