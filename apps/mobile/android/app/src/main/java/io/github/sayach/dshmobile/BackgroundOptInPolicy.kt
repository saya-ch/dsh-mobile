package io.github.sayach.dshmobile

/**
 * Why the background delivery service stopped. The reason decides whether the
 * persisted opt-in survives, so it is a decision input rather than a log label.
 */
enum class BackgroundStopReason {
    /** The active paired computer no longer exists, or the device record cannot be read. */
    DEVICE_MISSING,

    /** The device is paired over iroh, whose identity the foreground service cannot present. */
    DEVICE_IROH_UNSUPPORTED,

    /** The Host refused the device credential for good. */
    DEVICE_REVOKED,

    /** The device credential reached its own expiry. */
    DEVICE_EXPIRED,

    /** The pairing itself expired; a new pairing is required. */
    PAIRING_EXPIRED,

    /** The platform refused to start a foreground service, for example from the background. */
    PLATFORM_REJECTED_START,

    /** A bounded foreground service type spent its platform time budget. */
    FOREGROUND_TIMEOUT,
}

/**
 * The persisted opt-in records what the user asked for; it is not a claim that the
 * service is running right now. `connected` and `lastError` carry that claim.
 *
 * A reason the user can recover from without doing anything — a package replacement
 * that kills the process, a background-start restriction, a bounded foreground type
 * running out of time — must keep the opt-in, or an app upgrade silently discards a
 * choice the user made explicitly (#442). Only states that cannot heal on their own
 * withdraw it.
 */
object BackgroundOptInPolicy {
    /** Whether [reason] must leave the user's opt-in in place for the next start to retry. */
    fun keepsOptIn(reason: BackgroundStopReason): Boolean = when (reason) {
        BackgroundStopReason.PLATFORM_REJECTED_START,
        BackgroundStopReason.FOREGROUND_TIMEOUT,
        -> true

        BackgroundStopReason.DEVICE_MISSING,
        BackgroundStopReason.DEVICE_IROH_UNSUPPORTED,
        BackgroundStopReason.DEVICE_REVOKED,
        BackgroundStopReason.DEVICE_EXPIRED,
        BackgroundStopReason.PAIRING_EXPIRED,
        -> false
    }
}
