package io.github.sayach.dshmobile

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Missing data and temporarily unreadable encrypted data are different states. */
internal sealed interface CredentialRead<out T> {
    data object Absent : CredentialRead<Nothing>
    data class Loaded<T>(val value: T) : CredentialRead<T>
    data object Unreadable : CredentialRead<Nothing>
}

/** Mutations cannot treat an unreadable encrypted store as an empty store. */
internal class CredentialStorageUnavailable(cause: Throwable? = null) :
    IllegalStateException("secure_device_storage_unavailable", cause)

internal data class EncryptedCredential(val payload: String, val iv: String)

/** A write returns only after persistence acknowledges the encrypted payload, IV and markers. */
internal interface CredentialPreferences {
    fun string(key: String): String?
    fun boolean(key: String): Boolean
    fun write(strings: Map<String, String> = emptyMap(), booleans: Map<String, Boolean> = emptyMap())
    fun clear()
}

internal class AndroidCredentialPreferences(private val preferences: SharedPreferences) : CredentialPreferences {
    constructor(context: Context, name: String) : this(context.getSharedPreferences(name, Context.MODE_PRIVATE))

    override fun string(key: String): String? = synchronized(preferences) { preferences.getString(key, null) }
    override fun boolean(key: String): Boolean = synchronized(preferences) { preferences.getBoolean(key, false) }
    override fun write(strings: Map<String, String>, booleans: Map<String, Boolean>) {
        mutate(strings.keys + booleans.keys) {
            strings.forEach { (key, value) -> putString(key, value) }
            booleans.forEach { (key, value) -> putBoolean(key, value) }
        }
    }
    override fun clear() { mutate(null) { clear() } }

    /** SharedPreferences commits update memory before reporting disk failure; restore touched values. */
    private fun mutate(keys: Set<String>?, update: SharedPreferences.Editor.() -> Unit) = synchronized(preferences) {
        val before = try {
            preferences.all.let { values -> if (keys == null) values.toMap() else keys.associateWith { values[it] } }
                .mapValues { (_, value) -> if (value is Set<*>) value.toSet() else value }
        } catch (error: Exception) { throw CredentialStorageUnavailable(error) }
        try {
            if (!preferences.edit().apply(update).commit()) throw CredentialStorageUnavailable()
        } catch (error: Exception) {
            try {
                preferences.edit().apply {
                    if (keys == null) clear()
                    before.forEach { (key, value) ->
                        when (value) {
                            null -> remove(key)
                            is String -> putString(key, value)
                            is Boolean -> putBoolean(key, value)
                            is Int -> putInt(key, value)
                            is Long -> putLong(key, value)
                            is Float -> putFloat(key, value)
                            is Set<*> -> putStringSet(key, value.filterIsInstance<String>().toSet())
                            else -> throw CredentialStorageUnavailable()
                        }
                    }
                }.commit().also { restored ->
                    if (!restored) error.addSuppressed(CredentialStorageUnavailable())
                }
            } catch (restoreError: Exception) { error.addSuppressed(restoreError) }
            throw CredentialStorageUnavailable(error)
        }
    }
}

/** Encryption stays owned by Android Keystore in production; tests inject real JVM AES/GCM. */
internal interface CredentialEncryption {
    fun decrypt(payload: String, iv: String, alias: String): String
    fun encrypt(plaintext: String, alias: String, allowNewKey: Boolean): EncryptedCredential
    fun deleteKey(alias: String)
}

internal object AndroidCredentialEncryption : CredentialEncryption {
    private fun existingKey(alias: String): SecretKey? =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) as? SecretKey

    override fun decrypt(payload: String, iv: String, alias: String): String {
        val key = existingKey(alias) ?: throw CredentialStorageUnavailable()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.getDecoder().decode(iv)))
        return String(cipher.doFinal(Base64.getDecoder().decode(payload)), Charsets.UTF_8)
    }

    override fun encrypt(plaintext: String, alias: String, allowNewKey: Boolean): EncryptedCredential {
        val key = existingKey(alias) ?: if (allowNewKey) {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
                generateKey()
            }
        } else throw CredentialStorageUnavailable()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return EncryptedCredential(Base64.getEncoder().encodeToString(cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))),
            Base64.getEncoder().encodeToString(cipher.iv))
    }

    override fun deleteKey(alias: String) {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }
}
