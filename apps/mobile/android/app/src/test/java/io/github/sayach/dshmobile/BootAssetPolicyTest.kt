package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Only same-origin revisioned boot batches may enter the device-side cache. */
class BootAssetPolicyTest {
    private val origin = GatewayOrigin.parse("https://gateway.example")!!
    private val path = "/mobile-access/mobile-boot/${"a".repeat(64)}.js"

    @Test
    fun acceptsARevisionedSameOriginBatchAndKeepsTheOriginInTheKey() {
        assertEquals("https://gateway.example$path", BootAssetPolicy.key(origin, "https://gateway.example$path"))
        assertEquals(
            "https://gateway.example$path",
            BootAssetPolicy.key(origin, "https://gateway.example:443$path"),
        )
        assertEquals(
            "https://gateway.example$path",
            BootAssetPolicy.key(origin, "HTTPS://gateway.example$path"),
        )
    }

    @Test
    fun rejectsAnotherGatewayServingTheSameRevisionedPath() {
        val other = GatewayOrigin.parse("https://other.example")!!
        assertNull(BootAssetPolicy.key(other, "https://gateway.example$path"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example:8443$path"))
    }

    @Test
    fun rejectsNonHttpsAndAmbiguousUrls() {
        assertNull(BootAssetPolicy.key(origin, "http://gateway.example$path"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example$path?cache=1"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example$path#x"))
        assertNull(BootAssetPolicy.key(origin, "https://user@gateway.example$path"))
        assertNull(BootAssetPolicy.key(origin, "not a url"))
        assertNull(BootAssetPolicy.key(origin, ""))
    }

    @Test
    fun rejectsUnrevisionedAndNonBatchPaths() {
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/mobile-access/mobile-boot/boot.js"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/mobile-access/mobile-boot/${"A".repeat(64)}.js"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/mobile-access/mobile-boot/${"a".repeat(63)}.js"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/mobile-access/mobile-boot/${"a".repeat(65)}.js"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/mobile-access/mobile-boot/${"a".repeat(64)}.css"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/mobile-access/mobile-boot/../boot.js"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/mobile-access/compat.js"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/api/status"))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example/"))
    }

    @Test
    fun theMetricPathIsTheRevisionedPathWithoutOriginOrQuery() {
        assertEquals(path, BootAssetPolicy.path("https://gateway.example$path"))
        assertNull(BootAssetPolicy.path("https://gateway.example$path?v=1"))
        assertNull(BootAssetPolicy.path("https://gateway.example/mobile-access/compat.js"))
    }
}
