package io.github.sayach.dshmobile

import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The cache itself is covered behaviorally; this contract first proves the WebView-facing adapter
 * only ever answers boot batches and always falls back, then keeps the wiring from silently
 * widening what is intercepted or losing the two places that must clear the cache.
 */
class BootAssetCachingWiringTest {
    private val origin = GatewayOrigin.parse("https://gateway.example")!!
    private val path = "/mobile-access/mobile-boot/${"d".repeat(64)}.js"
    private val batchUrl = "https://gateway.example$path"

    private lateinit var directory: File
    private lateinit var store: BootAssetStore

    @Before
    fun setUp() {
        directory = kotlin.io.path.createTempDirectory("boot-wiring").toFile()
        store = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })
    }

    @After
    fun tearDown() {
        directory.deleteRecursively()
    }

    private class CountingFetcher(private val result: BootAssetFetch) : BootAssetFetcher {
        var calls = 0

        override fun fetch(url: String, etag: String?, cancellation: BootAssetCancellation): BootAssetFetch {
            calls += 1
            return result
        }
    }

    private fun body(text: String): BootAssetFetch {
        val bytes = text.toByteArray()
        return BootAssetFetch.Modified("\"v1\"", "text/javascript", bytes, BootAssetDigest.of(bytes), wireBytes = bytes.size.toLong())
    }

    @Test
    fun theAdapterAnswersOnlySubresourceGetsForABootBatch() {
        val fetcher = CountingFetcher(body("batch"))
        BootAssetCache(origin, store, fetcher).use { cache ->
            val responder = BootAssetResponder(cache)

            val served = responder.response("GET", false, batchUrl)

            assertNotNull(served)
            assertArrayEquals("batch".toByteArray(), served!!.body)
            assertEquals("text/javascript", served.contentType)
            assertEquals("\"v1\"", served.etag)

            assertNull("A document is never answered from the cache", responder.response("GET", true, batchUrl))
            assertNull("A non-GET method is never answered", responder.response("POST", false, batchUrl))
            assertNull("Another path is never answered", responder.response("GET", false, "https://gateway.example/mobile-access/compat.js"))
            assertNull("Another origin is never answered", responder.response("GET", false, "https://other.example$path"))
            assertEquals("Only the accepted batch reached the transport", 1, fetcher.calls)
        }
    }

    @Test
    fun aMissFallsBackToTheWebViewWithoutFabricatingABody() {
        listOf<BootAssetFetch>(BootAssetFetch.Failed, BootAssetFetch.Rejected, BootAssetFetch.Cancelled).forEach { result ->
            val fetcher = CountingFetcher(result)
            BootAssetCache(origin, store, fetcher).use { cache ->
                assertNull(BootAssetResponder(cache).response("GET", false, batchUrl))
            }
            assertEquals(1, fetcher.calls)
        }
        assertNull(store.entry(BootAssetPolicy.key(origin, batchUrl)!!))
    }

    @Test
    fun aDisabledOrClosedCacheIsIndistinguishableFromUpstream() {
        val fetcher = CountingFetcher(body("batch"))
        assertNull(BootAssetResponder(null).response("GET", false, batchUrl))
        assertEquals(0, fetcher.calls)

        val cache = BootAssetCache(origin, store, fetcher)
        cache.close()
        assertNull(BootAssetResponder(cache).response("GET", false, batchUrl))
        assertEquals("A closed cache never reaches the transport", 0, fetcher.calls)
    }

    @Test
    fun theClientInterceptsOnlySubresourceGetsAndNeverFabricatesABody() {
        val text = source("SecureWebViewClient.kt")
        val method = text.substringAfter("override fun shouldInterceptRequest(")
            .substringBefore("\n    override fun ")
        assertTrue(method.contains("bootAssets?.response(request.method, request.isForMainFrame, request.url.toString()) ?: return null"))
        assertTrue(method.contains("ByteArrayInputStream(served.body)"))
        assertTrue(method.contains("put(\"Content-Length\", served.body.size.toString())"))
        assertTrue(
            "A rejected response object must fall back instead of aborting the subresource",
            method.contains("runCatching {") && method.contains("}.getOrNull()"),
        )
    }

    @Test
    fun navigationAndDisposalCancelAnInFlightBootDownload() {
        val text = source("SecureWebViewClient.kt")
        val dispose = text.substringAfter("fun dispose()").substringBefore("\n    override fun ")
        val pageStarted = text.substringAfter("override fun onPageStarted(").substringBefore("\n    override fun ")
        assertTrue(dispose.contains("bootAssets?.cancelInFlight()"))
        assertTrue(pageStarted.contains("bootAssets?.cancelInFlight()"))
    }

    @Test
    fun theActivityWiresTheCacheAndClearsItWithSiteDataAndDeviceRemoval() {
        val text = source("MainActivity.kt")
        assertTrue(text.contains("private val bootAssetStore by lazy { BootAssetStore(File(filesDir, \"boot-assets\")) }"))
        assertTrue(text.contains("fetcher = HttpBootAssetFetcher(origin, transport, caCertificate, userAgent)"))
        assertTrue(text.contains("bootAssets = BootAssetResponder(createBootAssetCache(origin, caCertificate, browser.settings.userAgentString))"))

        val clearSiteData = text.substringAfter("private fun clearSiteData()").substringBefore("private fun shareGateway(")
        assertTrue(clearSiteData.contains("clearBootAssetStore()"))

        val deleteDevice = text.substringAfter("private fun confirmDeleteDevice(").substringBefore("private fun showDeviceUndo(")
        assertTrue(deleteDevice.contains("clearBootAssetStore()"))

        val clearHelper = text.substringAfter("private fun clearBootAssetStore()").substringBefore("private fun stopIrohTransport(")
        assertTrue("The store clear must not run on the UI thread", clearHelper.contains("ioExecutor.execute(task)"))
        assertTrue("A shutdown executor must not drop the clear", clearHelper.contains("task.run()"))

        val destroy = text.substringAfter("private fun destroyWebView(").substringBefore("private fun textView(")
        assertTrue("A destroyed WebView must stop its boot-cache workers", destroy.contains("cache.close()"))
        assertTrue("Teardown reports the device measurements", destroy.contains("logBootAssetMetrics(cache)"))
    }

    @Test
    fun thePatchCanBeSwitchedOffBackToUpstreamBehaviour() {
        val text = source("MainActivity.kt")
        val create = text.substringAfter("private fun createBootAssetCache(").substringBefore("private fun logBootAssetMetrics(")
        assertTrue(create.contains("if (!BOOT_ASSET_CACHE_ENABLED) return null"))
        assertFalse(BootAssetResponder(null).enabled)
    }

    private fun source(name: String): String = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base ->
            listOf("app/src/main", "src/main", "apps/mobile/android/app/src/main").asSequence()
                .map { File(base, "$it/java/io/github/sayach/dshmobile/$name") }
        }
        .first { it.isFile }
        .readText()
}
