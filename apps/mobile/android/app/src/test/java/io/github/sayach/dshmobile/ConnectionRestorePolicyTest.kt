package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifies cold-start ordering and persistence migration for LAN and remote connections. */
class ConnectionRestorePolicyTest {
    private val now = 1_000L
    private val lanCredential = credential("a", now + 10_000)
    private val remoteCredential = credential("b", now + 10_000)

    @Test
    fun restoresTheLastSuccessfulRemoteConnectionFirst() {
        val targets = targets(AccessMode.REMOTE)

        assertEquals(listOf(AccessMode.REMOTE, AccessMode.LAN), targets.map { it.mode })
        assertEquals("https://remote.cpolar.cn", targets.first().origin.serialized)
    }

    @Test
    fun restoresTheLastSuccessfulLanConnectionFirst() {
        val targets = targets(AccessMode.LAN)

        assertEquals(listOf(AccessMode.LAN, AccessMode.REMOTE), targets.map { it.mode })
    }

    @Test
    fun existingInstallWithoutModePrefersRemoteThenFallsBackToLan() {
        val targets = targets(null)

        assertEquals(listOf(AccessMode.REMOTE, AccessMode.LAN), targets.map { it.mode })
    }

    @Test
    fun ignoresExpiredOrMalformedPersistedConnections() {
        val targets = ConnectionRestorePolicy.targets(
            preferredMode = AccessMode.REMOTE,
            lanOrigin = "not-an-origin",
            lanCredential = lanCredential,
            remoteOrigin = "https://remote.cpolar.cn",
            remoteCredential = credential("b", now),
            now = now,
        )

        assertTrue(targets.isEmpty())
    }

    @Test
    fun retriesOnlyFailuresThatCanRecoverWithoutUserInput() {
        val transientKinds = listOf(
            NativeAuthFailureKind.TIMEOUT,
            NativeAuthFailureKind.NETWORK,
            NativeAuthFailureKind.SERVER_UNAVAILABLE,
        )

        transientKinds.forEach { kind ->
            assertEquals(
                RestoreFailureDisposition.RETRY_TRANSIENT,
                ConnectionRestorePolicy.failureDisposition(NativeAuthFailure(kind), instanceMismatch = false),
            )
        }
    }

    @Test
    fun stopsAutomaticRecoveryForPermanentFailuresAndIdentityChanges() {
        val permanentKinds = NativeAuthFailureKind.entries - setOf(
            NativeAuthFailureKind.TIMEOUT,
            NativeAuthFailureKind.NETWORK,
            NativeAuthFailureKind.SERVER_UNAVAILABLE,
        )

        permanentKinds.forEach { kind ->
            assertEquals(
                RestoreFailureDisposition.REQUIRE_USER_ACTION,
                ConnectionRestorePolicy.failureDisposition(NativeAuthFailure(kind), instanceMismatch = false),
            )
        }
        assertEquals(
            RestoreFailureDisposition.REQUIRE_USER_ACTION,
            ConnectionRestorePolicy.failureDisposition(null, instanceMismatch = false),
        )
        assertEquals(
            RestoreFailureDisposition.REQUIRE_USER_ACTION,
            ConnectionRestorePolicy.failureDisposition(
                NativeAuthFailure(NativeAuthFailureKind.NETWORK),
                instanceMismatch = true,
            ),
        )
    }

    @Test
    fun renewsOnlyAtThePreviouslySavedRemoteOrigin() {
        val savedOrigin = GatewayOrigin.parse("https://remote.cpolar.cn")!!
        assertTrue(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.REMOTE,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = savedOrigin,
            savedOrigin = savedOrigin,
            now = now,
        ))
        assertFalse(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.REMOTE,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = GatewayOrigin.parse("https://new-address.cpolar.cn")!!,
            savedOrigin = savedOrigin,
            now = now,
        ))
        // An attacker can copy the public instance id into a QR code. A new
        // HTTPS origin must not receive the existing bearer device token.
        assertFalse(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.REMOTE,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = GatewayOrigin.parse("https://attacker.example.com")!!,
            savedOrigin = savedOrigin,
            now = now,
        ))
        assertFalse(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.LAN,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = savedOrigin,
            savedOrigin = savedOrigin,
            now = now,
        ))
        assertTrue(ConnectionRestorePolicy.mayPairAfterRenewFailure(
            NativeAuthFailure(NativeAuthFailureKind.PAIRING_EXPIRED),
        ))
        assertEquals(
            false,
            ConnectionRestorePolicy.mayPairAfterRenewFailure(NativeAuthFailure(NativeAuthFailureKind.TIMEOUT)),
        )
    }

    private fun targets(preferredMode: AccessMode?): List<ConnectionRestoreTarget> =
        ConnectionRestorePolicy.targets(
            preferredMode = preferredMode,
            lanOrigin = "https://192.168.1.20:3443",
            lanCredential = lanCredential,
            remoteOrigin = "https://remote.cpolar.cn",
            remoteCredential = remoteCredential,
            now = now,
        )

    private fun credential(instanceCharacter: String, expiresAt: Long) = DeviceCredential(
        instanceId = instanceCharacter.repeat(64),
        deviceToken = "A".repeat(43),
        expiresAt = expiresAt,
        caCertificate = null,
    )
}
