package io.github.sayach.dshmobile

import android.content.Context
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** A device row state shown by the connection center. */
internal enum class PairedDeviceStatus {
    UNKNOWN,
    REACHABLE,
    UNREACHABLE,
    REVOKED,
    EXPIRED,
    ADDRESS_CHANGED,
}

/** One locally paired DSH installation; tokens and LAN CA bytes stay encrypted at rest. */
internal data class PairedDeviceRecord(
    val instanceId: String,
    val deviceId: String,
    val displayName: String,
    val mode: AccessMode,
    val origin: GatewayOrigin,
    val deviceToken: String,
    val expiresAt: Long,
    val caCertificate: ByteArray?,
    val lastConnectedAt: Long?,
    val lastReachableAt: Long?,
    val status: PairedDeviceStatus,
) {
    /** Stable local key used to merge a rotated cpolar origin or a re-pair. */
    val key: String get() = "${mode.name.lowercase()}:$instanceId"

}

/** Serializes encrypted row mutations and one-time migration from the two legacy slots. */
internal class PairedDeviceStore(
    private val preferences: CredentialPreferences,
    private val encryption: CredentialEncryption,
) {
    constructor(context: Context) : this(AndroidCredentialPreferences(context, PREFERENCES_NAME), AndroidCredentialEncryption)

    var storageUnavailable = false
        private set

    /** Read encrypted rows without converting a failed decryption into absent data. */
    @Synchronized
    fun read(): CredentialRead<List<PairedDeviceRecord>> {
        val (payload, iv) = try {
            preferences.boolean(MIGRATION_KEY)
            preferences.boolean(DISPLAY_ORDER_MIGRATION_KEY)
            preferences.string(PAYLOAD_KEY) to preferences.string(IV_KEY)
        } catch (_: Exception) {
            storageUnavailable = true
            return CredentialRead.Unreadable
        }
        val rows = if (payload == null && iv == null) null else decode(payload, iv)
        storageUnavailable = (payload != null || iv != null) && rows == null
        return when {
            storageUnavailable -> CredentialRead.Unreadable
            rows == null -> CredentialRead.Absent
            else -> CredentialRead.Loaded(rows)
        }
    }

    private fun rowsForMutation(): List<PairedDeviceRecord> = when (val current = read()) {
        CredentialRead.Absent -> emptyList()
        CredentialRead.Unreadable -> throw CredentialStorageUnavailable()
        is CredentialRead.Loaded -> try {
            PairedDeviceOrderPolicy.initialOrder(current.value, preferences.boolean(DISPLAY_ORDER_MIGRATION_KEY)).rows
        } catch (error: Exception) { throw CredentialStorageUnavailable(error) }
    }

    /** Preflight a credential-changing operation before any legacy slot is replaced. */
    @Synchronized
    fun requireReadable() { rowsForMutation() }

    /**
     * Return all valid rows in their stored order, which is the order the list displays.
     *
     * Connecting to a computer must not move its row; rows append when they are paired, and only
     * [moveUp] and [moveToTop] rearrange them. Startup selection stays with
     * `ConnectionRestorePolicy`, which prefers the saved key and otherwise the most recent
     * connection, so "the computer I used last" remains the default.
     */
    @Synchronized
    fun load(): List<PairedDeviceRecord> {
        val current = read()
        if (current == CredentialRead.Unreadable) return emptyList()
        val initial = try { PairedDeviceOrderPolicy.initialOrder(
            when (current) { CredentialRead.Absent -> emptyList(); CredentialRead.Unreadable -> null; is CredentialRead.Loaded -> current.value },
            preferences.boolean(DISPLAY_ORDER_MIGRATION_KEY),
        ) } catch (_: Exception) {
            storageUnavailable = true
            return emptyList()
        }
        try { when (initial.write) {
            PairedDeviceOrderPolicy.MigrationWrite.NONE -> Unit
            PairedDeviceOrderPolicy.MigrationWrite.EMPTY_MARKER ->
                preferences.write(booleans = mapOf(DISPLAY_ORDER_MIGRATION_KEY to true))
            PairedDeviceOrderPolicy.MigrationWrite.SORTED_ROWS -> {
                save(initial.rows)
            }
        } } catch (_: Exception) {
            // Readable rows remain available; migration retries after storage accepts writes.
            storageUnavailable = true
        }
        return initial.rows
    }

    /** Whether the store has completed the legacy-slot migration marker. */
    @Synchronized
    fun isMigrationComplete(): Boolean = try {
        preferences.boolean(MIGRATION_KEY)
    } catch (error: Exception) { throw CredentialStorageUnavailable(error) }

    /** Write legacy rows once without touching their old stores. */
    @Synchronized
    fun migrateLegacy(rows: List<PairedDeviceRecord>): List<PairedDeviceRecord> {
        if (isMigrationComplete()) return load()
        val existing = rowsForMutation()
        // Existing names, tokens and display order win over old fixed-slot copies.
        val combined = existing + rows.filter { legacy -> existing.none { it.key == legacy.key } }
        val normalized = if (existing.isEmpty()) PairedDeviceOrderPolicy.initialOrder(combined.distinctBy { it.key }, migrationComplete = false).rows else combined.distinctBy { it.key }
        if (normalized.isEmpty()) {
            try {
                preferences.write(booleans = mapOf(MIGRATION_KEY to true, DISPLAY_ORDER_MIGRATION_KEY to true))
            } catch (error: Exception) { throw CredentialStorageUnavailable(error) }
        } else {
            save(normalized, completeLegacyMigration = true)
        }
        return normalized
    }

    /** Insert or replace one row identified by its mode and DSH instance id. */
    @Synchronized
    fun upsert(record: PairedDeviceRecord): PairedDeviceRecord {
        val rows = rowsForMutation().toMutableList()
        val index = rows.indexOfFirst { it.key == record.key }
        if (index >= 0) rows[index] = record else rows += record
        save(rows)
        return record
    }

    /** Update one row while retaining its encrypted credential fields. */
    @Synchronized
    fun update(
        key: String,
        transform: (PairedDeviceRecord) -> PairedDeviceRecord,
    ): PairedDeviceRecord? {
        val rows = rowsForMutation().toMutableList()
        val index = rows.indexOfFirst { it.key == key }
        if (index < 0) return null
        val updated = transform(rows[index])
        rows[index] = updated
        save(rows)
        return updated
    }

    /** Remove one local row and its credential; the computer-side device is unchanged. */
    @Synchronized
    fun remove(key: String): Boolean {
        val rows = rowsForMutation().toMutableList()
        val removed = rows.removeIf { it.key == key }
        if (!removed) return false
        save(rows)
        return true
    }

    /** Move one row one position towards the front of the fixed display order. */
    @Synchronized
    fun moveUp(key: String): Boolean = reorder { PairedDeviceOrderPolicy.moveUp(it, key) }

    /** Move one row to the front of the fixed display order. */
    @Synchronized
    fun moveToTop(key: String): Boolean = reorder { PairedDeviceOrderPolicy.moveToTop(it, key) }

    /** Persist a new row order; a transform that leaves every key in place writes nothing. */
    private fun reorder(transform: (List<PairedDeviceRecord>) -> List<PairedDeviceRecord>): Boolean {
        val rows = rowsForMutation()
        val reordered = transform(rows)
        if (reordered.map { it.key } == rows.map { it.key }) return false
        save(reordered)
        return true
    }

    /** Remove every local row and the encryption key. */
    @Synchronized
    fun clear() {
        try { preferences.clear() } catch (error: Exception) { throw CredentialStorageUnavailable(error) }
        runCatching { encryption.deleteKey(KEY_ALIAS) }
    }

    private fun save(
        rows: List<PairedDeviceRecord>,
        completeLegacyMigration: Boolean = false,
    ) {
        if (rows.size > MAX_DEVICES) throw CredentialStorageUnavailable()
        val json = JSONArray()
        rows.forEach { row ->
            requireValid(row)
            json.put(encode(row))
        }
        try {
            val encrypted = encryption.encrypt(json.toString(), KEY_ALIAS, allowNewKey = preferences.string(PAYLOAD_KEY) == null && preferences.string(IV_KEY) == null)
            preferences.write(strings = mapOf(PAYLOAD_KEY to encrypted.payload, IV_KEY to encrypted.iv),
                booleans = mapOf(DISPLAY_ORDER_MIGRATION_KEY to true) + if (completeLegacyMigration) mapOf(MIGRATION_KEY to true) else emptyMap())
        } catch (error: Exception) { throw CredentialStorageUnavailable(error) }
    }

    private fun decode(payload: String?, iv: String?): List<PairedDeviceRecord>? {
        if (payload.isNullOrBlank() || iv.isNullOrBlank()) return null
        val text = runCatching { encryption.decrypt(payload, iv, KEY_ALIAS) }.getOrNull() ?: return null
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return null
        val rows = mutableListOf<PairedDeviceRecord>()
        for (index in 0 until array.length()) {
            rows += parse(array.optJSONObject(index)) ?: return null
        }
        if (rows.size > MAX_DEVICES || rows.distinctBy { it.key }.size != rows.size) return null
        return rows
    }

    private fun parse(value: JSONObject?): PairedDeviceRecord? {
        if (value == null || value.optInt("version", -1) != 1) return null
        val instanceId = value.optString("instanceId")
        val deviceId = value.optString("deviceId")
        val token = value.optString("deviceToken")
        val mode = AccessMode.parse(value.optString("mode")) ?: return null
        val origin = GatewayOrigin.parse(value.optString("origin")) ?: return null
        val name = normalizeDisplayName(value.optString("displayName")) ?: return null
        val expiresAt = value.optLong("expiresAt", -1L)
        val ca = value.optString("caCertificate", PUBLIC_TLS).takeUnless { it == PUBLIC_TLS }?.let {
            runCatching { Base64.getDecoder().decode(it) }.getOrNull() ?: return null
        }
        val status = runCatching { PairedDeviceStatus.valueOf(value.optString("status")) }.getOrNull() ?: PairedDeviceStatus.UNKNOWN
        val row = PairedDeviceRecord(
            instanceId = instanceId,
            deviceId = deviceId,
            displayName = name,
            mode = mode,
            origin = origin,
            deviceToken = token,
            expiresAt = expiresAt,
            caCertificate = ca,
            lastConnectedAt = optionalLong(value, "lastConnectedAt"),
            lastReachableAt = optionalLong(value, "lastReachableAt"),
            status = status,
        )
        return row.takeIf { isValid(it) }
    }

    private fun encode(row: PairedDeviceRecord): JSONObject = JSONObject().apply {
        put("version", 1)
        put("instanceId", row.instanceId)
        put("deviceId", row.deviceId)
        put("displayName", row.displayName)
        put("mode", row.mode.name)
        put("origin", row.origin.serialized)
        put("deviceToken", row.deviceToken)
        put("expiresAt", row.expiresAt)
        put("caCertificate", row.caCertificate?.let { Base64.getEncoder().encodeToString(it) } ?: PUBLIC_TLS)
        if (row.lastConnectedAt != null) put("lastConnectedAt", row.lastConnectedAt)
        if (row.lastReachableAt != null) put("lastReachableAt", row.lastReachableAt)
        put("status", row.status.name)
    }

    private fun requireValid(row: PairedDeviceRecord) {
        require(isValid(row)) { "invalid paired device record" }
    }

    private fun isValid(row: PairedDeviceRecord): Boolean =
        INSTANCE_ID.matches(row.instanceId)
            && (row.deviceId.isEmpty() || DEVICE_ID.matches(row.deviceId))
            && TOKEN.matches(row.deviceToken)
            && RemoteHostPolicy.isAllowed(row.mode, row.origin.host)
            && row.expiresAt > 0L
            && PairedDeviceRecordPolicy.acceptsTrustAnchor(row.mode, row.caCertificate, row.instanceId)
            && normalizeDisplayName(row.displayName) != null

    private fun normalizeDisplayName(value: String): String? {
        val normalized = java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFC).trim()
        if (normalized.length > MAX_NAME_CHARS || CONTROL_CHARS.containsMatchIn(normalized)) return null
        return normalized.takeIf { it.isNotEmpty() }
    }

    private fun optionalLong(value: JSONObject, key: String): Long? =
        if (!value.has(key) || value.isNull(key)) null else value.optLong(key, Long.MIN_VALUE).takeIf { it > 0L }

    private companion object {
        const val PREFERENCES_NAME = "dsh_mobile_devices_v1"
        const val PAYLOAD_KEY = "payload"
        const val IV_KEY = "iv"
        const val MIGRATION_KEY = "legacy_migrated"
        const val DISPLAY_ORDER_MIGRATION_KEY = "display_order_migrated_v1"
        const val KEY_ALIAS = "dsh_mobile_devices_v1"
        const val PUBLIC_TLS = "-"
        const val MAX_DEVICES = 64
        const val MAX_NAME_CHARS = 32
        val CONTROL_CHARS = Regex("[\\u0000-\\u001f\\u007f]")
        val INSTANCE_ID = Regex("^[a-f0-9]{64}$")
        val DEVICE_ID = Regex("^[a-f0-9]{32}$")
        val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    }
}
