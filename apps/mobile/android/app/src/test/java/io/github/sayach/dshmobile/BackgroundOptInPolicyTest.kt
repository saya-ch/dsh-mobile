package io.github.sayach.dshmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A package replacement kills the process and the system's sticky restart happens while the
 * app is in the background, where Android 12+ refuses to start a foreground service. That
 * refusal used to erase the persisted opt-in, so every App upgrade silently turned the
 * user's explicit choice off (#442). The decision lives here so it can be tested directly.
 */
class BackgroundOptInPolicyTest {

    @Test
    fun aPackageReplacementIsNotAnOptOut() {
        // The restart the OS attempts after an upgrade is rejected from the background.
        assertTrue(BackgroundOptInPolicy.keepsOptIn(BackgroundStopReason.PLATFORM_REJECTED_START))
        // A bounded foreground type runs out of time on its own schedule; the budget refills.
        assertTrue(BackgroundOptInPolicy.keepsOptIn(BackgroundStopReason.FOREGROUND_TIMEOUT))
    }

    @Test
    fun anUnrecoverableStateWithdrawsTheOptIn() {
        // These cannot heal without the user pairing again or changing device.
        assertFalse(BackgroundOptInPolicy.keepsOptIn(BackgroundStopReason.DEVICE_MISSING))
        assertFalse(BackgroundOptInPolicy.keepsOptIn(BackgroundStopReason.DEVICE_IROH_UNSUPPORTED))
        assertFalse(BackgroundOptInPolicy.keepsOptIn(BackgroundStopReason.DEVICE_REVOKED))
        assertFalse(BackgroundOptInPolicy.keepsOptIn(BackgroundStopReason.DEVICE_EXPIRED))
        assertFalse(BackgroundOptInPolicy.keepsOptIn(BackgroundStopReason.PAIRING_EXPIRED))
    }

    @Test
    fun everyStopReasonIsDecidedExplicitly() {
        // Adding a reason must force a decision instead of defaulting to either answer.
        val reasons = BackgroundStopReason.entries
        assertTrue(reasons.size >= 7)
        val retained = reasons.filter(BackgroundOptInPolicy::keepsOptIn)
        val withdrawn = reasons.filterNot(BackgroundOptInPolicy::keepsOptIn)
        // Both sides must stay reachable: a policy that answers one way for every reason is
        // the bug this policy exists to prevent.
        assertTrue(retained.isNotEmpty())
        assertTrue(withdrawn.isNotEmpty())
        assertTrue(retained.contains(BackgroundStopReason.PLATFORM_REJECTED_START))
    }
}
