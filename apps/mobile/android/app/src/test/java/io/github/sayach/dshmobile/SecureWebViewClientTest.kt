package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureWebViewClientTest {
    @Test
    fun cpolarPagesReceiveEnoughTimeForTheProxiedClientBundle() {
        assertEquals(120_000L, webViewLoadTimeoutMs("private-name.r8.cpolar.cn"))
        assertEquals(120_000L, webViewLoadTimeoutMs("PRIVATE-NAME.CPOLAR.IO"))
    }

    @Test
    fun otherRemotePagesKeepTheShorterRemoteBudget() {
        assertEquals(30_000L, webViewLoadTimeoutMs("computer.tail1234.ts.net"))
        assertEquals(30_000L, webViewLoadTimeoutMs("dsh.example.com"))
        assertEquals(15_000L, webViewLoadTimeoutMs("192.168.1.20"))
    }

    @Test
    fun subframesCannotNavigateAcrossOrigins() {
        val origin = GatewayOrigin.parse("https://trusted.example:3443")!!
        assertFalse(shouldBlockSubframeNavigation(origin, "https://trusted.example:3443/embed"))
        assertTrue(shouldBlockSubframeNavigation(origin, "https://other.example/embed"))
        assertTrue(shouldBlockSubframeNavigation(origin, "https://trusted.example/embed"))
    }
}
