package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The cache answers plugin combo bundles as well as boot batches.
 *
 * A combo URL carries its whole identity in the query — the ordered module list plus the content
 * revision — so the storage key must include it; two module selections that share `/plugins/` must
 * never share a cache entry.
 */
class BootAssetPluginComboTest {
    private val origin = GatewayOrigin.parse("https://gateway.example")!!
    private val base = "https://gateway.example"
    private val one = "$base/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=e6f3c3604a26"
    private val two = "$base/plugins/??@a/b/client.js,@c/d/client.js&rev=0cf1a2b3"

    @Test
    fun acceptsAComboBundleAndKeysItByTheWholeQuery() {
        assertEquals(one, BootAssetPolicy.key(origin, one))
        assertEquals(two, BootAssetPolicy.key(origin, two))
        // Two selections under the same path must not collide.
        assertNotEquals(BootAssetPolicy.key(origin, one), BootAssetPolicy.key(origin, two))
    }

    @Test
    fun aNewRevisionIsANewEntry() {
        val bumped = one.replace("rev=e6f3c3604a26", "rev=aaaa1111")
        assertNotEquals(BootAssetPolicy.key(origin, one), BootAssetPolicy.key(origin, bumped))
    }

    @Test
    fun theMetricsLabelStaysShortAndCarriesNoModuleList() {
        val label = BootAssetPolicy.path(one)
        assertEquals("/plugins/ rev=e6f3c3604a26", label)
        // Nothing from the module list may leak into a log line.
        assert(!label!!.contains("deepseek-ai"))
    }

    @Test
    fun rejectsCombosWithoutARevisionOrWithASourceMap() {
        assertNull(BootAssetPolicy.path("$base/plugins/??@a/b/client.js"))
        assertNull(BootAssetPolicy.path("$base/plugins/??@a/b/client.js&rev="))
        assertNull(BootAssetPolicy.path("$base/plugins/??@a/b/client.js&rev=ab"))
        assertNull(BootAssetPolicy.path("$base/plugins/??@a/b/client.js.map&rev=abcd1234"))
    }

    @Test
    fun rejectsAnotherOriginOrAnInsecureScheme() {
        val other = GatewayOrigin.parse("https://other.example")!!
        assertNull(BootAssetPolicy.key(other, one))
        assertNull(BootAssetPolicy.key(origin, one.replace("https://", "http://")))
        assertNull(BootAssetPolicy.key(origin, "https://gateway.example:8443/plugins/??@a/b/client.js&rev=e6f3c3604a26"))
    }

    @Test
    fun rejectsUserInfoAndFragments() {
        assertNull(BootAssetPolicy.key(origin, one.replace("gateway.example", "user:pw@gateway.example")))
        assertNull(BootAssetPolicy.key(origin, "$one#fragment"))
    }

    @Test
    fun stillRejectsOrdinaryPluginFiles() {
        // A single module file is not a combo and stays with the WebView.
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/@a/b/client.js?rev=e6f3c3604a26"))
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/manifest.json?rev=e6f3c3604a26"))
    }

    @Test
    fun bootBatchesKeepTheirExistingKeys() {
        val batch = "/mobile-access/mobile-boot/${"a".repeat(64)}.js"
        assertEquals("$base$batch", BootAssetPolicy.key(origin, "$base$batch"))
        assertEquals(batch, BootAssetPolicy.path("$base$batch"))
    }

    @Test
    fun combosAreImmutableButBootBatchesAreNot() {
        // A combo URL names its revision, so a stored body is final.
        assertEquals(true, BootAssetPolicy.isImmutable(one))
        // A boot batch path can be reassembled with different layout bytes, so it must revalidate.
        val batch = "$base/mobile-access/mobile-boot/${"a".repeat(64)}.js"
        assertEquals(false, BootAssetPolicy.isImmutable(batch))
        assertEquals(false, BootAssetPolicy.isImmutable("$base/plugins/@a/b/client.js?rev=e6f3c3604a26"))
    }
}
