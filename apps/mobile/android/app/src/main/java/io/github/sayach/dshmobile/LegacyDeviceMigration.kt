package io.github.sayach.dshmobile

internal data class LegacyDeviceSlot(
    val mode: AccessMode,
    val origin: GatewayOrigin?,
    val credential: CredentialRead<DeviceCredential>,
    val displayName: String,
    val lastConnectedAt: Long?,
)

/** Complete migration only after every existing legacy slot can be read; retain newer device rows. */
internal fun migrateLegacyPairedDevices(store: PairedDeviceStore, slots: List<LegacyDeviceSlot>, now: Long) {
    if (store.isMigrationComplete()) return
    store.requireReadable()
    val rows = slots.mapNotNull { slot ->
        when (val read = slot.credential) {
            CredentialRead.Absent -> null
            CredentialRead.Unreadable -> throw CredentialStorageUnavailable()
            is CredentialRead.Loaded -> {
                val credential = read.value
                val origin = slot.origin ?: throw CredentialStorageUnavailable()
                PairedDeviceRecord(
                    instanceId = credential.instanceId, deviceId = "", displayName = slot.displayName,
                    mode = slot.mode, origin = origin, deviceToken = credential.deviceToken,
                    expiresAt = credential.expiresAt, caCertificate = credential.caCertificate,
                    lastConnectedAt = slot.lastConnectedAt, lastReachableAt = null,
                    status = if (credential.expiresAt > now) PairedDeviceStatus.UNKNOWN else PairedDeviceStatus.EXPIRED,
                )
            }
        }
    }
    store.migrateLegacy(rows)
}

/** Completed migration makes the multi-device list authoritative, including an empty list. */
internal fun readLegacyCredentialForRestore(
    store: PairedDeviceStore,
    readLegacy: () -> CredentialRead<DeviceCredential>,
): CredentialRead<DeviceCredential> = try {
    if (store.isMigrationComplete()) CredentialRead.Absent else readLegacy()
} catch (_: CredentialStorageUnavailable) { CredentialRead.Unreadable }
