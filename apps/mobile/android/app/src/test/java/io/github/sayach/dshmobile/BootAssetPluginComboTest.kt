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
        // A revisioned single module is accepted (see the extended-policy test); a non-script or
        // unversioned plugin resource stays with the WebView.
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/manifest.json?rev=e6f3c3604a26"))
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/@a/b/client.js"))
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
        // A single plugin file names its build in `?rev=`, so a stored body is final too.
        assertEquals(true, BootAssetPolicy.isImmutable("$base/plugins/@a/b/client.js?rev=e6f3c3604a26"))
    }

    @Test
    fun acceptsSinglePluginFilesAndHashedAssets() {
        val single = "$base/plugins/dsh-cost-meter/client.js?rev=e6f3c3604a26"
        assertEquals(single, BootAssetPolicy.key(origin, single))
        assertEquals(true, BootAssetPolicy.isImmutable(single))

        val scoped = "$base/plugins/@a/b/client.js?rev=e6f3c3604a26"
        assertEquals(scoped, BootAssetPolicy.key(origin, scoped))

        val asset = "$base/assets/index-BXV-oxvX.js"
        assertEquals(asset, BootAssetPolicy.key(origin, asset))
        assertEquals(true, BootAssetPolicy.isImmutable(asset))
        // A hashed asset may also carry a revision; then the revision is part of the key.
        assertEquals("$asset?rev=e6f3c3604a26", BootAssetPolicy.key(origin, "$asset?rev=e6f3c3604a26"))
    }

    @Test
    fun stillRejectsUnversionedOrNonScriptPluginFiles() {
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/dsh-cost-meter/client.js"))
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/dsh-cost-meter/client.js.map?rev=e6f3c3604a26"))
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/dsh-cost-meter/package.json?rev=e6f3c3604a26"))
        // An asset without a content digest is not addressed, so it stays with the WebView.
        assertNull(BootAssetPolicy.key(origin, "$base/assets/index.js"))
        assertNull(BootAssetPolicy.key(origin, "$base/assets/logo.png"))
    }

    @Test
    fun acceptsPluginFacetScriptsButNotSourceMaps() {
        for (facet in listOf("client.statistics.js", "client.sidebar-order.js", "client.peak.js")) {
            val url = "$base/plugins/dsh-cost-meter/$facet?rev=e46a240884f6"
            assertEquals(url, BootAssetPolicy.key(origin, url))
            assertEquals(true, BootAssetPolicy.isImmutable(url))
        }
        assertNull(BootAssetPolicy.key(origin, "$base/plugins/dsh-cost-meter/client.statistics.js.map?rev=e46a240884f6"))
    }
}
