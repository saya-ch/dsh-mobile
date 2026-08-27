package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Verifies that a pairing QR selects its own transport instead of relying on the current screen. */
class PairingScanPolicyTest {
    private val instanceId = "a".repeat(64)
    private val token = "A".repeat(43)

    @Test
    fun selectsLanForPrivateGatewayLinks() {
        val target = PairingScanPolicy.parse(pairingLink("192.168.1.20:3443"))

        assertEquals(AccessMode.LAN, target?.mode)
        assertEquals("https://192.168.1.20:3443", target?.connection?.origin?.serialized)
    }

    @Test
    fun selectsRemoteForSupportedTunnelLinks() {
        val target = PairingScanPolicy.parse(pairingLink("example.cpolar.cn"))

        assertEquals(AccessMode.REMOTE, target?.mode)
        assertEquals("https://example.cpolar.cn", target?.connection?.origin?.serialized)
    }

    @Test
    fun rejectsContentThatIsNotAPairingLink() {
        assertNull(PairingScanPolicy.parse("https://192.168.1.20:3443"))
        assertNull(PairingScanPolicy.parse("dsh1.$instanceId.$token"))
    }

    private fun pairingLink(host: String): String =
        "https://$host/mobile-access/pair#instance=$instanceId&token=$token"
}
