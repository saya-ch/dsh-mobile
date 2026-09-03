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
    fun acceptsAUserOwnedDomainOnlyFromTheRemoteFlow() {
        val remote = PairingScanPolicy.parse(pairingLink("dsh.example.com"), AccessMode.REMOTE)
        val lan = PairingScanPolicy.parse(pairingLink("dsh.example.com"), AccessMode.LAN)

        assertEquals(AccessMode.REMOTE, remote?.mode)
        assertNull(lan)
    }

    @Test
    fun acceptsAPublicIpv4OnlyFromTheRemoteFlow() {
        val remote = PairingScanPolicy.parse(pairingLink("1.2.3.4"), AccessMode.REMOTE)
        val lan = PairingScanPolicy.parse(pairingLink("1.2.3.4"), AccessMode.LAN)

        assertEquals(AccessMode.REMOTE, remote?.mode)
        assertNull(lan)
    }

    @Test
    fun rejectsDocumentationIpv4FromTheRemoteFlow() {
        // TEST-NET addresses are not globally routable and can never be a VPS endpoint.
        // (The LAN flow still treats unknown literals as ordinary non-remote hosts.)
        for (host in listOf("192.0.2.1", "198.51.100.7", "203.0.113.10")) {
            assertNull(PairingScanPolicy.parse(pairingLink(host), AccessMode.REMOTE))
        }
    }

    @Test
    fun rejectsContentThatIsNotAPairingLink() {
        assertNull(PairingScanPolicy.parse("https://192.168.1.20:3443"))
        assertNull(PairingScanPolicy.parse("dsh1.$instanceId.$token"))
    }

    private fun pairingLink(host: String): String =
        "https://$host/mobile-access/pair#instance=$instanceId&token=$token"
}
