package io.github.sayach.dshmobile

/** A validated pairing link together with the connection mode implied by its host. */
internal data class PairingScanTarget(
    val connection: GatewayConnection,
    val mode: AccessMode,
)

/** Parses pairing QR contents without depending on the screen that opened the scanner. */
internal object PairingScanPolicy {
    fun parse(rawValue: String): PairingScanTarget? {
        val normalized = rawValue.trim()
        if (GatewayUrlPolicy.pairingKey(normalized) == null) return null
        val connection = GatewayConnection.parse(normalized) ?: return null
        val mode = if (RemoteHostPolicy.isSupported(connection.origin.host)) {
            AccessMode.REMOTE
        } else {
            AccessMode.LAN
        }
        return PairingScanTarget(connection, mode)
    }
}
