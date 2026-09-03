package io.github.sayach.dshmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifies provider detection for remote links and the Tailscale-only connectivity notice. */
class RemoteHostPolicyTest {
    @Test
    fun recognizesSupportedRemoteProvidersCaseInsensitively() {
        assertTrue(RemoteHostPolicy.isSupported("computer.tail1234.ts.net"))
        assertTrue(RemoteHostPolicy.isSupported("EXAMPLE.CPOLAR.CN"))
        assertFalse(RemoteHostPolicy.isSupported("192.168.1.20"))
        assertTrue(RemoteHostPolicy.isRemoteCandidate("dsh.example.com"))
        assertTrue(RemoteHostPolicy.isRemoteCandidate("1.2.3.4"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("192.168.1.20"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("10.0.0.8"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("100.64.0.8"))
        // Documentation TEST-NET addresses can never be a real VPS endpoint.
        assertFalse(RemoteHostPolicy.isRemoteCandidate("192.0.2.1"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("198.51.100.7"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("203.0.113.10"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("198.18.0.1"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("224.0.0.1"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("255.255.255.255"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("computer.local"))
    }

    @Test
    fun warnsOnlyForTailscale() {
        assertTrue(RemoteHostPolicy.needsTailscaleVpnNotice("computer.tail1234.ts.net"))
        assertFalse(RemoteHostPolicy.needsTailscaleVpnNotice("example.cpolar.cn"))
        assertFalse(RemoteHostPolicy.needsTailscaleVpnNotice("192.168.1.20"))
    }

    @Test
    fun enforcesTheSelectedConnectionModeAtTheFinalOrigin() {
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.LAN, "192.168.1.20"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.LAN, "dsh-example.cpolar.cn"))
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "dsh-example.cpolar.cn"))
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "dsh.example.com"))
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "1.2.3.4"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.LAN, "1.2.3.4"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "203.0.113.10"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "computer.local"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.LAN, "dsh.example.com"))
    }
}
