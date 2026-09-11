package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionIssuePolicyTest {
    @Test
    fun classifiesActionableMainFrameHttpFailures() {
        assertEquals(LoadFailure.AUTH_EXPIRED, loadFailureForHttpStatus(401))
        assertEquals(LoadFailure.RATE_LIMITED, loadFailureForHttpStatus(429))
        assertEquals(LoadFailure.SERVICE_UNAVAILABLE, loadFailureForHttpStatus(500))
        assertEquals(LoadFailure.SERVICE_UNAVAILABLE, loadFailureForHttpStatus(503))
        assertEquals(LoadFailure.SERVICE_UNAVAILABLE, loadFailureForHttpStatus(599))
        assertEquals(LoadFailure.NETWORK, loadFailureForHttpStatus(404))
    }

    @Test
    fun offersAddressRefreshOnlyForCpolarRemoteNetworkFailures() {
        val cpolar = GatewayOrigin.parse("https://example.cpolar.cn")
        val tailscale = GatewayOrigin.parse("https://computer.tail1234.ts.net")
        val selfHosted = GatewayOrigin.parse("https://dsh.example.com")

        assertTrue(isCpolarAddressFailure(LoadFailure.NETWORK, AccessMode.REMOTE, cpolar))
        assertFalse(isCpolarAddressFailure(LoadFailure.NETWORK, AccessMode.LAN, cpolar))
        assertFalse(isCpolarAddressFailure(LoadFailure.SERVICE_UNAVAILABLE, AccessMode.REMOTE, cpolar))
        assertFalse(isCpolarAddressFailure(LoadFailure.NETWORK, AccessMode.REMOTE, tailscale))
        assertFalse(isCpolarAddressFailure(LoadFailure.NETWORK, AccessMode.REMOTE, selfHosted))
        assertFalse(isCpolarAddressFailure(LoadFailure.NETWORK, AccessMode.REMOTE, null))
    }

    @Test
    fun declinesNearbyPermissionWithoutDisablingFallbackDiscovery() {
        assertTrue(NearbyDiscoveryPermissionPolicy.shouldRequest(33, granted = false, previouslyDeclined = false))
        assertFalse(NearbyDiscoveryPermissionPolicy.shouldRequest(33, granted = false, previouslyDeclined = true))
        assertFalse(NearbyDiscoveryPermissionPolicy.shouldRequest(33, granted = true, previouslyDeclined = true))
        assertFalse(NearbyDiscoveryPermissionPolicy.shouldRequest(32, granted = false, previouslyDeclined = false))
    }
}
