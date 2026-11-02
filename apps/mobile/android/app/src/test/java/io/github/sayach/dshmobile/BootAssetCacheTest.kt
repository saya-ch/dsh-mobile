package io.github.sayach.dshmobile

import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The cache serves bytes only after the current session answered, and replaces them on a 200. */
class BootAssetCacheTest {
    private val origin = GatewayOrigin.parse("https://gateway.example")!!
    private val path = "/mobile-access/mobile-boot/${"b".repeat(64)}.js"
    private val batchUrl = "https://gateway.example$path"
    private val key: String get() = BootAssetPolicy.key(origin, batchUrl)!!

    private lateinit var directory: File
    private lateinit var store: BootAssetStore

    @Before
    fun setUp() {
        directory = kotlin.io.path.createTempDirectory("boot-cache").toFile()
        store = BootAssetStore(directory, quotaBytes = 1_000, clock = { 1_000L })
    }

    @After
    fun tearDown() {
        directory.deleteRecursively()
    }

    private class ScriptedFetcher(private val handler: (String, String?) -> BootAssetFetch) : BootAssetFetcher {
        val calls = CopyOnWriteArrayList<Pair<String, String?>>()

        override fun fetch(url: String, etag: String?, cancellation: BootAssetCancellation): BootAssetFetch {
            calls += url to etag
            return handler(url, etag)
        }
    }

    private fun modified(
        text: String = "body",
        etag: String? = "\"v1\"",
        contentType: String = "text/javascript",
    ): BootAssetFetch.Modified {
        val bytes = text.toByteArray()
        return BootAssetFetch.Modified(etag, contentType, bytes, BootAssetDigest.of(bytes))
    }

    private fun preload(text: String, etag: String = "\"v1\"") {
        val bytes = text.toByteArray()
        val ticket = store.beginWrite(key, store.currentEpoch())!!
        assertTrue(store.commit(ticket, etag, "text/javascript", bytes, BootAssetDigest.of(bytes)))
    }

    private fun newCache(
        fetcher: BootAssetFetcher,
        metrics: BootAssetMetrics = BootAssetMetrics(),
        deadlineMs: Long = BOOT_ASSET_INTERCEPT_DEADLINE_MS,
    ): BootAssetCache = BootAssetCache(origin, store, fetcher, metrics, deadlineMs = deadlineMs)

    @Test
    fun coldLoadStoresTheBodyUnderItsRevisionedKey() {
        val fetcher = ScriptedFetcher { _, _ -> modified() }
        val metrics = BootAssetMetrics()
        newCache(fetcher, metrics).use { cache ->
            val result = cache.resolve(batchUrl)

            assertTrue(result is BootAssetCache.Result.Body)
            assertArrayEquals("body".toByteArray(), (result as BootAssetCache.Result.Body).body)
            assertEquals(listOf(batchUrl to null), fetcher.calls.toList())
            assertEquals("\"v1\"", store.entry(key)?.etag)
            assertEquals(BootAssetDigest.of("body".toByteArray()), store.entry(key)?.digest)
            val snapshot = metrics.snapshot()
            assertEquals(1L, snapshot.misses)
            assertEquals(0L, snapshot.hits)
            assertEquals(0L, snapshot.bytesSaved)
            assertEquals(4L, snapshot.bytesServed)
            assertEquals(1L, snapshot.requests)
        }
    }

    @Test
    fun revalidatedHitServesTheStoredBodyAndSendsTheStoredValidator() {
        preload("stored")
        val fetcher = ScriptedFetcher { _, _ -> BootAssetFetch.NotModified }
        val metrics = BootAssetMetrics()
        newCache(fetcher, metrics).use { cache ->
            val result = cache.resolve(batchUrl)

            assertArrayEquals("stored".toByteArray(), (result as BootAssetCache.Result.Body).body)
            assertEquals(listOf(batchUrl to "\"v1\""), fetcher.calls.toList())
            val snapshot = metrics.snapshot()
            assertEquals(1L, snapshot.hits)
            assertEquals(1L, snapshot.revalidated)
            assertEquals(0L, snapshot.misses)
            assertEquals(6L, snapshot.bytesServed)
            assertEquals(6L, snapshot.bytesSaved)
            assertEquals(100, snapshot.hitPercent)
        }
    }

    @Test
    fun aModifiedResponseReplacesTheStoredBytes() {
        preload("old")
        val fetcher = ScriptedFetcher { _, _ -> modified(text = "new", etag = "\"v2\"") }
        newCache(fetcher).use { cache ->
            val result = cache.resolve(batchUrl)

            assertArrayEquals("new".toByteArray(), (result as BootAssetCache.Result.Body).body)
            val lease = store.acquire(key)
            assertNotNull(lease)
            assertArrayEquals("new".toByteArray(), lease!!.use { it.body })
            assertEquals("\"v2\"", store.entry(key)?.etag)
        }
    }

    @Test
    fun aRejectedSessionNeverServesTheCachedBody() {
        preload("stored")
        val metrics = BootAssetMetrics()
        newCache(ScriptedFetcher { _, _ -> BootAssetFetch.Rejected }, metrics).use { cache ->
            assertEquals(BootAssetCache.Result.Miss, cache.resolve(batchUrl))
        }
        assertEquals(1L, metrics.snapshot().rejected)
        assertEquals("The stored copy survives a refused session", "\"v1\"", store.entry(key)?.etag)
    }

    @Test
    fun aFailedFetchNeverStoresBytes() {
        newCache(ScriptedFetcher { _, _ -> BootAssetFetch.Failed }).use { cache ->
            assertEquals(BootAssetCache.Result.Miss, cache.resolve(batchUrl))
        }
        assertNull(store.entry(key))
    }

    @Test
    fun responsesWithoutAValidatorAreServedButNotStored() {
        val result = newCache(ScriptedFetcher { _, _ -> modified(etag = null) }).use { it.resolve(batchUrl) }

        assertTrue(result is BootAssetCache.Result.Body)
        assertNull(store.entry(key))
    }

    @Test
    fun nonJavaScriptResponsesFallBackToTheWebViewAndAreNotCached() {
        val result = newCache(ScriptedFetcher { _, _ -> modified(contentType = "text/plain") }).use { it.resolve(batchUrl) }

        assertEquals(BootAssetCache.Result.Miss, result)
        assertNull(store.entry(key))
    }

    @Test
    fun revisionedAssetsOutsideTheBootPrefixNeverReachTheFetcher() {
        val fetcher = ScriptedFetcher { _, _ -> modified() }
        val metrics = BootAssetMetrics()
        val result = newCache(fetcher, metrics).use { it.resolve("https://gateway.example/mobile-access/compat.js") }

        assertEquals(BootAssetCache.Result.Miss, result)
        assertTrue(fetcher.calls.isEmpty())
        assertEquals("Ordinary subresources are not metrics events", 0L, metrics.snapshot().requests)
    }

    @Test
    fun aStoredBodyThatNoLongerVerifiesIsRefetchedWithoutTheValidator() {
        preload("stored")
        directory.listFiles()!!.first { it.name.endsWith(".bin") }.writeBytes("xxxxxx".toByteArray())
        val fetcher = ScriptedFetcher { _, _ -> modified(text = "fresh", etag = "\"v2\"") }

        val result = newCache(fetcher).use { it.resolve(batchUrl) }

        assertArrayEquals("fresh".toByteArray(), (result as BootAssetCache.Result.Body).body)
        assertEquals(listOf(batchUrl to null), fetcher.calls.toList())
        assertEquals("\"v2\"", store.entry(key)?.etag)
    }

    @Test
    fun clearingTheStoreDuringADownloadDiscardsTheBodyInsteadOfWritingItBack() {
        val fetcher = object : BootAssetFetcher {
            override fun fetch(url: String, etag: String?, cancellation: BootAssetCancellation): BootAssetFetch {
                store.clear()
                return modified(text = "downloaded")
            }
        }
        val metrics = BootAssetMetrics()
        newCache(fetcher, metrics).use { cache ->
            val result = cache.resolve(batchUrl)

            // The verified bytes may still be served, but nothing from that generation may be stored.
            assertArrayEquals("downloaded".toByteArray(), (result as BootAssetCache.Result.Body).body)
        }
        assertNull(store.entry(key))
        assertTrue((directory.listFiles() ?: emptyArray()).none { it.name.endsWith(".bin") })
        assertEquals(1L, metrics.snapshot().misses)
    }

    @Test
    fun cancellingInFlightStopsTheDownloadAndStoresNothing() {
        val entered = CountDownLatch(1)
        val fetcher = object : BootAssetFetcher {
            override fun fetch(url: String, etag: String?, cancellation: BootAssetCancellation): BootAssetFetch {
                entered.countDown()
                while (!cancellation.isCancelled) Thread.sleep(CANCEL_POLL_MS)
                return BootAssetFetch.Cancelled
            }
        }
        val metrics = BootAssetMetrics()
        newCache(fetcher, metrics).use { cache ->
            val result = AtomicReference<BootAssetCache.Result?>(null)
            val thread = Thread({ result.set(cache.resolve(batchUrl)) }, "boot-asset-cache-cancel-test")
            thread.start()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            cache.cancelInFlight()
            thread.join(5_000)

            assertEquals(BootAssetCache.Result.Miss, result.get())
            assertFalse("Cancellation must release the caller", thread.isAlive)
        }
        assertNull(store.entry(key))
        assertEquals(1L, metrics.snapshot().cancelled)
    }

    @Test
    fun aDownloadThatOutlivesItsDeadlineFallsBackToTheWebView() {
        val fetcher = object : BootAssetFetcher {
            override fun fetch(url: String, etag: String?, cancellation: BootAssetCancellation): BootAssetFetch {
                Thread.sleep(3_000)
                return modified()
            }
        }
        val metrics = BootAssetMetrics()
        newCache(fetcher, metrics, deadlineMs = 100L).use { cache ->
            assertEquals(BootAssetCache.Result.Miss, cache.resolve(batchUrl))
            assertEquals(1L, metrics.snapshot().cancelled)
        }
        assertNull(store.entry(key))
    }

    @Test
    fun aClosedCacheBehavesExactlyLikeUpstream() {
        val fetcher = ScriptedFetcher { _, _ -> modified() }
        val closed = newCache(fetcher)
        closed.close()

        assertEquals(BootAssetCache.Result.Miss, closed.resolve(batchUrl))
        assertTrue(fetcher.calls.isEmpty())
    }

    @Test
    fun twoConcurrentRequestsForOneBatchProduceExactlyOneStoredBody() {
        val fetcher = ScriptedFetcher { _, _ ->
            Thread.sleep(20)
            modified()
        }
        newCache(fetcher).use { cache ->
            val results = CopyOnWriteArrayList<BootAssetCache.Result>()
            val threads = (1..2).map { index ->
                Thread({ results += cache.resolve(batchUrl) }, "boot-asset-cache-race-$index")
            }
            threads.forEach(Thread::start)
            threads.forEach { it.join(5_000) }

            assertEquals(2, results.size)
            results.forEach { assertTrue(it is BootAssetCache.Result.Body) }
        }
        assertEquals(1, (directory.listFiles() ?: emptyArray()).count { it.name.endsWith(".bin") })
        assertEquals("\"v1\"", store.entry(key)?.etag)
    }

    @Test
    fun aSnapshotCarriesCountersButNeverTheOriginTheCookieOrTheSession() {
        preload("stored")
        val metrics = BootAssetMetrics()
        newCache(ScriptedFetcher { _, _ -> BootAssetFetch.NotModified }, metrics).use { it.resolve(batchUrl) }

        val summary = metrics.snapshot().summary()

        assertFalse(summary.contains("gateway.example"))
        assertFalse(summary.contains("cookie", ignoreCase = true))
        assertFalse(summary.contains("dsh_ma_session"))
        assertFalse(summary.contains("?"))
        assertTrue(summary.contains(path))
    }

    @Test
    fun everyRevalidatedHitReportsAFullySavedStart() {
        preload("stored")
        val metrics = BootAssetMetrics()
        newCache(ScriptedFetcher { _, _ -> BootAssetFetch.NotModified }, metrics).use { cache ->
            cache.resolve(batchUrl)
            cache.resolve(batchUrl)
        }

        val snapshot = metrics.snapshot()
        assertEquals(2L, snapshot.hits)
        assertEquals(0L, snapshot.bytesFetched)
        assertEquals(12L, snapshot.bytesSaved)
        assertEquals("Serving hits also counts as served bytes; that must not halve the share", 100, snapshot.savedPercent)
        assertTrue(snapshot.summary().contains("fetched=0B"))
    }

    @Test
    fun aColdStartReportsNoSavingAtAll() {
        val metrics = BootAssetMetrics()
        newCache(ScriptedFetcher { _, _ -> modified(text = "cold") }, metrics).use { cache ->
            cache.resolve(batchUrl)
            cache.resolve(batchUrl)
        }

        val snapshot = metrics.snapshot()
        assertEquals(2L, snapshot.misses)
        assertEquals(0L, snapshot.bytesSaved)
        assertEquals(8L, snapshot.bytesFetched)
        assertEquals(8L, snapshot.bytesServed)
        assertEquals(0, snapshot.savedPercent)
    }

    @Test
    fun aMixedStartWeightsEachByteByWhetherItCrossedTheNetwork() {
        preload("stored")
        val metrics = BootAssetMetrics()
        var calls = 0
        val fetcher = ScriptedFetcher { _, _ ->
            calls += 1
            if (calls == 1) BootAssetFetch.NotModified else modified(text = "fresh", etag = "\"v2\"")
        }
        newCache(fetcher, metrics).use { cache ->
            cache.resolve(batchUrl)
            cache.resolve(batchUrl)
        }

        val snapshot = metrics.snapshot()
        // One 6-byte hit after a 304, then one 5-byte re-download.
        assertEquals(1L, snapshot.hits)
        assertEquals(1L, snapshot.misses)
        assertEquals(11L, snapshot.bytesServed)
        assertEquals(5L, snapshot.bytesFetched)
        assertEquals(6L, snapshot.bytesSaved)
        assertEquals("6 saved / (6 saved + 5 fetched) = 54%", 54, snapshot.savedPercent)
    }

    @Test
    fun theInterceptionWaitStaysWellBelowThePageBudget() {
        assertTrue(
            "The Chromium request thread blocks on this wait, so it must stay in single-digit seconds",
            BOOT_ASSET_INTERCEPT_DEADLINE_MS in 1L..8_000L,
        )
        assertTrue(
            "A healthy handshake must never be cut off by the wait ceiling",
            BOOT_ASSET_INTERCEPT_DEADLINE_MS > BOOT_ASSET_CONNECT_TIMEOUT_MS,
        )
    }

    private companion object {
        const val CANCEL_POLL_MS = 5L
    }
}
