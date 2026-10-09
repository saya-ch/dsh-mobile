package io.github.sayach.dshmobile

import android.content.Context
import java.util.Base64

private const val DEVICE_CREDENTIAL_KEY_ALIAS = "dsh_mobile_device_v1"

internal data class DeviceCredential(
    val instanceId: String,
    val deviceToken: String,
    val expiresAt: Long,
    val caCertificate: ByteArray?,
)

/** Serializes this slot's reads and writes; tokens use a non-exportable Android Keystore key. */
internal class DeviceCredentialStore(
    private val preferences: CredentialPreferences,
    private val encryption: CredentialEncryption,
    private val slot: String = "lan",
) {
    constructor(context: Context, slot: String = "lan") : this(
        AndroidCredentialPreferences(context, if (slot == "lan") "dsh_mobile_device" else "dsh_mobile_device_$slot"),
        AndroidCredentialEncryption, slot,
    )

    @Synchronized
    fun load(): DeviceCredential? = (read() as? CredentialRead.Loaded)?.value

    /** Preserve an unreadable legacy slot so migration can retry after Keystore becomes available. */
    @Synchronized
    fun read(): CredentialRead<DeviceCredential> {
        val (encrypted, iv) = try {
            preferences.string("credential") to preferences.string("iv")
        } catch (_: Exception) { return CredentialRead.Unreadable }
        if (encrypted == null && iv == null) return CredentialRead.Absent
        if (encrypted.isNullOrBlank() || iv.isNullOrBlank()) return CredentialRead.Unreadable
        val aliases = buildList {
            add(deviceCredentialKeyAlias(slot))
            if (slot != "lan") add(DEVICE_CREDENTIAL_KEY_ALIAS)
        }.distinct()
        for (alias in aliases) {
            val plaintext = runCatching { encryption.decrypt(encrypted, iv, alias) }.getOrNull() ?: continue
            val credential = decode(plaintext) ?: continue
            if (alias != deviceCredentialKeyAlias(slot)) {
                runCatching { writeCredential(credential, allowNewKey = true) }
            }
            return CredentialRead.Loaded(credential)
        }
        return CredentialRead.Unreadable
    }

    @Synchronized
    fun save(credential: DeviceCredential) {
        val current = read()
        if (current == CredentialRead.Unreadable) throw CredentialStorageUnavailable()
        writeCredential(credential, allowNewKey = current == CredentialRead.Absent)
    }

    private fun writeCredential(credential: DeviceCredential, allowNewKey: Boolean) {
        require(INSTANCE_ID.matches(credential.instanceId) && TOKEN.matches(credential.deviceToken))
        val encodedCa = credential.caCertificate?.let {
            require(PairingTrust.validateCertificate(it, credential.instanceId) != null)
            Base64.getEncoder().encodeToString(it)
        } ?: PUBLIC_TLS.also { require(slot != "lan") }
        val plaintext = "${credential.instanceId}\n${credential.deviceToken}\n${credential.expiresAt}\n$encodedCa"
        try {
            val encrypted = encryption.encrypt(plaintext, deviceCredentialKeyAlias(slot), allowNewKey)
            preferences.write(strings = mapOf("credential" to encrypted.payload, "iv" to encrypted.iv))
        } catch (error: Exception) { throw CredentialStorageUnavailable(error) }
    }

    @Synchronized
    fun clear() {
        try { preferences.clear() } catch (error: Exception) { throw CredentialStorageUnavailable(error) }
    }

    private fun decode(plaintext: String): DeviceCredential? {
        return try {
            val fields = plaintext.split('\n')
            if (fields.size != 4 || !INSTANCE_ID.matches(fields[0]) || !TOKEN.matches(fields[1])) return null
            val expiresAt = fields[2].toLongOrNull()?.takeIf { it > 0L } ?: return null
            val ca = fields[3].takeUnless { it == PUBLIC_TLS }?.let { Base64.getDecoder().decode(it) }
            if (slot == "lan" && ca == null) return null
            if (ca == null) DeviceCredential(fields[0], fields[1], expiresAt, null)
            else PairingTrust.validateCertificate(ca, fields[0])?.let {
                DeviceCredential(fields[0], fields[1], expiresAt, it)
            }
        } catch (_: Exception) {
            null
        }
    }

    private companion object {
        const val PUBLIC_TLS = "-"
        val INSTANCE_ID = Regex("^[a-f0-9]{64}$")
        val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    }
}

/** Returns the stable Android Keystore alias for one credential slot. */
internal fun deviceCredentialKeyAlias(slot: String): String =
    if (slot == "lan") DEVICE_CREDENTIAL_KEY_ALIAS else "${DEVICE_CREDENTIAL_KEY_ALIAS}_$slot"
