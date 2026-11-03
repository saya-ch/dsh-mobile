package io.github.sayach.dshmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `onReceivedSslError` answers certificate errors for `wss:` handshakes as well as `https:`
 * subresources, so the pinned-authority check must accept the secure WebSocket scheme without
 * widening host or port.
 */
class GatewayUrlPolicyWebSocketTest {
    private val origin = requireNotNull(GatewayOrigin.parse("https://192.168.1.11:3443"))

    @Test
    fun acceptsTheSameSecureAuthority() {
        assertTrue(GatewayUrlPolicy.isPinnedAuthority(origin, "https://192.168.1.11:3443/"))
        assertTrue(
            GatewayUrlPolicy.isPinnedAuthority(
                origin,
                "wss://192.168.1.11:3443/api/remote.mux",
            ),
        )
    }

    @Test
    fun acceptsAnExplicitDefaultPortForAnImplicitOriginPort() {
        val implicit = requireNotNull(GatewayOrigin.parse("https://gateway.example"))
        assertTrue(GatewayUrlPolicy.isPinnedAuthority(implicit, "wss://gateway.example:443/sidebar/ws"))
        assertTrue(GatewayUrlPolicy.isPinnedAuthority(implicit, "https://gateway.example/"))
    }

    @Test
    fun rejectsAnotherPortOrHost() {
        assertFalse(
            GatewayUrlPolicy.isPinnedAuthority(
                origin,
                "wss://192.168.1.11:4443/api/remote.mux",
            ),
        )
        assertFalse(
            GatewayUrlPolicy.isPinnedAuthority(
                origin,
                "wss://192.168.1.12:3443/api/remote.mux",
            ),
        )
    }

    @Test
    fun rejectsCleartextAndUnsupportedSchemes() {
        assertFalse(GatewayUrlPolicy.isPinnedAuthority(origin, "ws://192.168.1.11:3443/api/remote.mux"))
        assertFalse(GatewayUrlPolicy.isPinnedAuthority(origin, "http://192.168.1.11:3443/"))
        assertFalse(GatewayUrlPolicy.isPinnedAuthority(origin, "file:///data/local/tmp/x"))
        assertFalse(GatewayUrlPolicy.isPinnedAuthority(origin, "not a url"))
    }

    @Test
    fun rejectsCredentialsInTheUrl() {
        assertFalse(
            GatewayUrlPolicy.isPinnedAuthority(
                origin,
                "wss://user:secret@192.168.1.11:3443/api/remote.mux",
            ),
        )
    }

    @Test
    fun rejectsIpv6LoopbackForAnIpv4Origin() {
        assertFalse(GatewayUrlPolicy.isPinnedAuthority(origin, "wss://[::1]:3443/api/remote.mux"))
        val loopback = requireNotNull(GatewayOrigin.parse("https://[::1]:3443"))
        assertTrue(GatewayUrlPolicy.isPinnedAuthority(loopback, "wss://[::1]:3443/api/remote.mux"))
        assertNotNull(loopback)
    }
}
