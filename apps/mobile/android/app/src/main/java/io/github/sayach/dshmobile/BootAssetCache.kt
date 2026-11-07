package io.github.sayach.dshmobile

import java.net.URI
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Callable
import java.util.concurrent.CancellationException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.RejectedExecutionHandler
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Local kill switch for the restored patch. `false` restores the 0.8.1 behaviour exactly: no store
 * is created, nothing is intercepted, and the WebView owns every request.
 */
internal const val BOOT_ASSET_CACHE_ENABLED = true

/**
 * Decides which URLs may be answered by the device-side boot-asset cache.
 *
 * Only the gateway's content-revisioned batches qualify: `origin + path` is the module-selection
 * key, and every hit still revalidates because the same path can be reassembled with different
 * layout bytes. Documents, API responses, credentials and non-revisioned assets never qualify.
 */
internal object BootAssetPolicy {
    private val REVISIONED_BATCH = Regex("^/mobile-access/mobile-boot/[0-9a-f]{64}\\.js$")

    /**
     * A plugin combo bundle: `/plugins/??<id>/client.js,<id>/client.js&rev=<hash>`.
     *
     * The whole query is the identity — the ordered module list plus the revision — so it is the
     * storage key, not decoration. Only `client.js` combos qualify; source maps and single-module
     * files stay with the WebView.
     */
    // `URI` strips the query separator, so the leading `?` here is the combo marker itself:
    // `/plugins/??<ids>&rev=<hash>` yields rawQuery = "?<ids>&rev=<hash>".
    private val COMBO_QUERY = Regex(
        "^\\?[A-Za-z0-9@._/-]+/client\\.js(?:,[A-Za-z0-9@._/-]+/client\\.js)*&rev=[A-Za-z0-9_-]{4,128}$",
    )
    private val COMBO_REV = Regex("&rev=([A-Za-z0-9_-]{4,128})$")

    /**
     * A single plugin file: `/plugins/<id>/client.<facet>.js?rev=<hash>`.
     *
     * Plugins split their client into facets (`client.statistics.js`, `client.peak.js`), so the
     * name is `client` followed by optional dot-segments. Source maps carry `.map` and never match.
     */
    private val SINGLE_PLUGIN = Regex("^/plugins/[A-Za-z0-9@._/-]+/client(?:\\.[A-Za-z0-9_-]+)*\\.(?:js|css)$")
    private val REV_ONLY = Regex("^rev=[A-Za-z0-9_-]{4,128}$")

    /** An owned asset whose file name already carries its content digest. */
    private val HASHED_ASSET = Regex("^/assets/[A-Za-z0-9@._/-]+-[A-Za-z0-9_-]{8,}\\.(?:js|css)$")

    /** Returns the revisioned batch path, or null when this URL is not a cacheable batch at all. */
    fun path(rawUrl: String): String? {
        val candidate = runCatching { URI(rawUrl) }.getOrNull() ?: return null
        if (!candidate.isAbsolute || candidate.isOpaque) return null
        if (candidate.scheme?.lowercase() != "https") return null
        if (candidate.rawUserInfo != null || candidate.rawFragment != null) return null
        val path = candidate.rawPath ?: return null
        if (REVISIONED_BATCH.matches(path) && candidate.rawQuery == null) return path
        val query = candidate.rawQuery
        // A combo bundle is keyed by its full query; metrics get a short, query-free label.
        if (path == COMBO_PATH) {
            if (query == null || !COMBO_QUERY.matches(query)) return null
            val rev = COMBO_REV.find(query)?.groupValues?.get(1) ?: return null
            return "$COMBO_PATH rev=$rev"
        }
        // A single plugin file names its own module in the path and its build in `?rev=`.
        if (SINGLE_PLUGIN.matches(path)) {
            if (query == null || !REV_ONLY.matches(query)) return null
            return "$path rev=${query.removePrefix("rev=")}"
        }
        // An owned asset carries the content digest in its file name, so the path is the identity.
        if (HASHED_ASSET.matches(path) && (query == null || REV_ONLY.matches(query))) return path
        return null
    }

    /** Returns the storage key, or null when the cache must not answer this URL. */
    fun key(origin: GatewayOrigin, rawUrl: String): String? {
        path(rawUrl) ?: return null
        if (!GatewayUrlPolicy.isSameOrigin(origin, rawUrl)) return null
        val candidate = runCatching { URI(rawUrl) }.getOrNull() ?: return null
        // A combo bundle is keyed by its full query too, or two module selections would collide.
        val query = candidate.rawQuery
        val identity = if (query.isNullOrEmpty()) candidate.rawPath else "${candidate.rawPath}?$query"
        return origin.serialized + identity
    }

    /**
     * Whether a stored body for this URL is final.
     *
     * A boot batch is not: the gateway can reassemble the same path from a changed layout, so every
     * hit revalidates with `If-None-Match`. A plugin combo is named by the ordered module list plus
     * the revision the host computed for those artifacts, so a stored body for that exact URL is
     * what the host asked for — revalidating it would buy nothing and cost a round-trip.
     */
    fun isImmutable(rawUrl: String): Boolean {
        path(rawUrl) ?: return false
        val candidate = runCatching { URI(rawUrl) }.getOrNull() ?: return false
        val path = candidate.rawPath ?: return false
        if (REVISIONED_BATCH.matches(path)) return false   // the gateway can reassemble it
        return true
    }

    private const val COMBO_PATH = "/plugins/"
}

/**
 * One transport attempt for a boot batch; only [Modified] carries bytes to serve.
 *
 * [Modified.body] is always a complete, verified transfer: the fetcher has already compared the bytes
 * it read off the wire with the response's declared `Content-Length` and refused a mismatch, so the
 * length check does not need to travel with the body. Nothing is exposed here that the store would
 * have to re-interpret.
 */
internal sealed interface BootAssetFetch {
    data class Modified(
        val etag: String?,
        val contentType: String,
        val body: ByteArray,
        /** SHA-256 of [body]; the store refuses anything that does not hash to this value. */
        val digest: String,
        /**
         * Bytes that actually crossed the wire for this body — the compressed transfer size, not
         * [body]`.size`. Benefit reports must quote this, never the decoded length.
         */
        val wireBytes: Long,
    ) : BootAssetFetch

    data object NotModified : BootAssetFetch
    data object Rejected : BootAssetFetch
    data object Failed : BootAssetFetch

    /** The page navigated away, the view was destroyed or the app exited. Nothing may be stored. */
    data object Cancelled : BootAssetFetch
}

/** Performs the authenticated conditional request that keeps a cached body valid. */
internal interface BootAssetFetcher {
    fun fetch(url: String, etag: String?, cancellation: BootAssetCancellation): BootAssetFetch
}

/**
 * One cancellable boot-batch request.
 *
 * `shouldInterceptRequest` already runs on a Chromium background thread, but a navigation, a
 * destroyed WebView or app exit must be able to stop a download that thread is blocked on. Listeners
 * therefore run from whichever thread cancels; they must be idempotent.
 */
internal class BootAssetCancellation {
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val cancelled = AtomicBoolean(false)

    val isCancelled: Boolean get() = cancelled.get()

    fun onCancel(listener: () -> Unit) {
        listeners += listener
        if (cancelled.get()) listener()
    }

    fun cancel() {
        if (!cancelled.compareAndSet(false, true)) return
        listeners.forEach { listener -> runCatching(listener) }
        listeners.clear()
    }
}

/** One resolved interception with everything the caller needs to record it exactly once. */
internal class BootAssetDecision(
    val outcome: BootAssetOutcome,
    val result: BootAssetCache.Result,
    val bytesServed: Long = 0L,
    /** Response-body bytes that crossed the network for this decision; 0 for a revalidated hit. */
    val bytesFetched: Long = 0L,
    val bytesSaved: Long = 0L,
    /** Wire bytes this decision actually transferred; the auditable form of [bytesFetched]. */
    val wireFetched: Long = 0L,
    val durationMs: Long = 0L,
)

/** Outcome of handing one boot-batch job to [BootAssetRequests]. */
internal sealed interface BootAssetJob {
    data class Done(val value: BootAssetDecision) : BootAssetJob
    data object Rejected : BootAssetJob
    data object Cancelled : BootAssetJob
    data object Failed : BootAssetJob
}

/**
 * Owns every thread that talks to the gateway for the boot cache.
 *
 * The pool is bounded (two workers, a four-entry queue) because a boot batch is at most a handful of
 * subresources; a saturated pool refuses work instead of queueing it, so the WebView falls back to
 * its own fetch rather than waiting. [close] stops the workers, which is what makes a destroyed
 * WebView leave no thread, socket or temporary file behind.
 */
internal class BootAssetRequests(
    threads: Int = DEFAULT_THREADS,
    queueCapacity: Int = DEFAULT_QUEUE_CAPACITY,
) : AutoCloseable {
    private val cancellations = CopyOnWriteArrayList<BootAssetCancellation>()
    private val closed = AtomicBoolean(false)
    private val threadIds = AtomicInteger()
    private val pool = ThreadPoolExecutor(
        threads,
        threads,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(queueCapacity),
        ThreadFactory { task ->
            Thread(task, "dsh-boot-cache-${threadIds.incrementAndGet()}").apply { isDaemon = true }
        },
        RejectedExecutionHandler { _, _ -> throw RejectedExecutionException("boot cache saturated") },
    )

    /** Runs [task] on the pool and waits for it, or cancels it when [deadlineMs] passes. */
    internal fun await(
        cancellation: BootAssetCancellation,
        deadlineMs: Long,
        task: () -> BootAssetDecision,
    ): BootAssetJob {
        if (closed.get()) return BootAssetJob.Cancelled
        // Register before submitting: a cancel must never miss a job that has already started.
        cancellations += cancellation
        try {
            if (cancellation.isCancelled) return BootAssetJob.Cancelled
            val future = try {
                pool.submit(Callable { task() })
            } catch (_: RejectedExecutionException) {
                return BootAssetJob.Rejected
            }
            return try {
                BootAssetJob.Done(future.get(deadlineMs, TimeUnit.MILLISECONDS))
            } catch (_: TimeoutException) {
                cancellation.cancel()
                future.cancel(true)
                BootAssetJob.Cancelled
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                cancellation.cancel()
                future.cancel(true)
                BootAssetJob.Cancelled
            } catch (_: ExecutionException) {
                BootAssetJob.Failed
            } catch (_: CancellationException) {
                BootAssetJob.Cancelled
            }
        } finally {
            cancellations -= cancellation
        }
    }

    /** Stops every in-flight download; called on navigation, dispose and teardown. */
    fun cancelAll() {
        cancellations.forEach { it.cancel() }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        cancelAll()
        pool.shutdownNow()
        runCatching { pool.awaitTermination(SHUTDOWN_TIMEOUT_MS, TimeUnit.MILLISECONDS) }
    }

    private companion object {
        const val DEFAULT_THREADS = 2
        const val DEFAULT_QUEUE_CAPACITY = 4
        const val SHUTDOWN_TIMEOUT_MS = 500L
    }
}

/**
 * Serves a boot batch from disk only after the current session revalidated it.
 *
 * The URL is content-revisioned against the module list, but the gateway reassembles the layout
 * batch when its layout file changes. A URL hit therefore still sends `If-None-Match`: a 304 keeps
 * the stored body, a 200 replaces it, and 401/403/network failures fall through to the WebView so
 * authentication and revocation keep their normal behavior.
 *
 * The four defer conditions of 0.8.1 live here and in [BootAssetStore]:
 * 1. cancellation — every download runs on [BootAssetRequests]; [cancelInFlight] and [close]
 *    disconnect the socket, and a cancelled attempt serves and stores nothing;
 * 2. body consistency — the fetcher refuses a transfer whose wire bytes disagree with
 *    `Content-Length` and hands over a SHA-256 of the decoded body; the store refuses a body that
 *    contradicts that digest, writes `.part` + atomic rename, and re-verifies on every read;
 * 3. clear-versus-download isolation — the store epoch is captured before the download and a
 *    commit is refused when it moved, when the key was evicted, or when a second writer owns it;
 * 4. measurement — [metrics] counts hits, misses, revalidations, served/fetched/saved bytes and
 *    latency without cookies, query strings, origins or session identifiers.
 *
 * [deadlineMs] bounds how long the Chromium request thread waits for us. It is deliberately short:
 * the WebView is blocked on this call and "fall back" (returning null so the WebView performs the
 * request itself) is a normal outcome, not a failure. It must stay above the fetcher's connect budget
 * so a healthy connection is never cut off mid-handshake.
 */
internal class BootAssetCache(
    private val origin: GatewayOrigin,
    private val store: BootAssetStore,
    private val fetcher: BootAssetFetcher,
    val metrics: BootAssetMetrics = BootAssetMetrics(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val requests: BootAssetRequests = BootAssetRequests(),
    private val deadlineMs: Long = BOOT_ASSET_INTERCEPT_DEADLINE_MS,
) : AutoCloseable {
    internal sealed interface Result {
        data class Body(val body: ByteArray, val contentType: String, val etag: String?) : Result
        data object Miss : Result
    }

    private val closed = AtomicBoolean(false)

    val isClosed: Boolean get() = closed.get()

    fun resolve(rawUrl: String): Result {
        if (closed.get()) return Result.Miss
        // Non-boot URLs are not metrics events: every page has dozens of ordinary subresources.
        val key = BootAssetPolicy.key(origin, rawUrl) ?: return Result.Miss
        val path = BootAssetPolicy.path(rawUrl) ?: return Result.Miss
        val epoch = store.currentEpoch()
        val cancellation = BootAssetCancellation()
        return when (val job = requests.await(cancellation, deadlineMs) { decideBoot(key, path, rawUrl, epoch, cancellation) }) {
            is BootAssetJob.Done -> {
                val decision = job.value
                metrics.record(
                    decision.outcome,
                    path,
                    bytesServed = decision.bytesServed,
                    bytesFetched = decision.bytesFetched,
                    bytesSaved = decision.bytesSaved,
                    wireFetched = decision.wireFetched,
                    durationMs = decision.durationMs,
                )
                decision.result
            }
            BootAssetJob.Rejected -> {
                metrics.record(BootAssetOutcome.CONTENDED, path)
                Result.Miss
            }
            // A timeout cancels the transfer, so the caller must not be served either.
            BootAssetJob.Cancelled -> {
                metrics.record(BootAssetOutcome.CANCELLED, path)
                Result.Miss
            }
            BootAssetJob.Failed -> {
                metrics.record(BootAssetOutcome.FAILED, path)
                Result.Miss
            }
        }
    }

    /** Cancels every in-flight download; a cancelled attempt can neither serve nor store. */
    fun cancelInFlight() {
        requests.cancelAll()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        requests.close()
    }

    private fun decideBoot(
        key: String,
        path: String,
        rawUrl: String,
        epoch: Long,
        cancellation: BootAssetCancellation,
    ): BootAssetDecision {
        val started = clock()
        val lease = store.acquire(key)
        if (cancellation.isCancelled) {
            lease?.close()
            return decide(BootAssetOutcome.CANCELLED, started)
        }
        // A revision-named combo is served from disk without a network round-trip; a boot batch
        // still revalidates because its path can be reassembled with different bytes.
        if (lease != null && BootAssetPolicy.isImmutable(rawUrl)) {
            return serveRevalidated(key, lease, started)
        }
        val fetched = try {
            fetcher.fetch(rawUrl, lease?.entry?.etag, cancellation)
        } catch (_: Exception) {
            if (cancellation.isCancelled) BootAssetFetch.Cancelled else BootAssetFetch.Failed
        }
        return when (fetched) {
            BootAssetFetch.Cancelled -> {
                lease?.close()
                decide(BootAssetOutcome.CANCELLED, started)
            }
            BootAssetFetch.Rejected -> {
                lease?.close()
                decide(BootAssetOutcome.REJECTED, started)
            }
            BootAssetFetch.Failed -> {
                lease?.close()
                decide(BootAssetOutcome.FAILED, started)
            }
            BootAssetFetch.NotModified -> {
                metrics.recordRevalidated()
                if (lease == null) {
                    // The stored body failed verification, so no validator was sent: a 304 here is
                    // a protocol anomaly and the WebView keeps the request.
                    decide(BootAssetOutcome.FAILED, started)
                } else {
                    serveRevalidated(key, lease, started)
                }
            }
            is BootAssetFetch.Modified -> {
                lease?.close()
                storeAndServe(key, rawUrl, epoch, cancellation, fetched, started)
            }
        }
    }

    private fun serveRevalidated(key: String, lease: BootAssetStore.Lease, started: Long): BootAssetDecision = lease.use {
        store.markUsed(key)
        BootAssetDecision(
            outcome = BootAssetOutcome.HIT,
            result = Result.Body(it.body, it.entry.contentType, it.entry.etag),
            bytesServed = it.entry.size,
            bytesFetched = 0L,
            bytesSaved = it.entry.size,
            durationMs = clock() - started,
        )
    }

    private fun storeAndServe(
        key: String,
        rawUrl: String,
        epoch: Long,
        cancellation: BootAssetCancellation,
        modified: BootAssetFetch.Modified,
        started: Long,
    ): BootAssetDecision {
        // Anything but a script or stylesheet means the response is not one of the resources the
        // policy may serve; leave it to the WebView.
        if (!isCacheableContentType(modified.contentType)) return decide(BootAssetOutcome.FAILED, started)
        // The gateway does not send an `ETag` for plugin combos, whose URL already names the
        // revision, so the content digest becomes the stored validator. Nothing is sent as
        // `If-None-Match` for those URLs; it only has to be non-blank for the store.
        val etag = modified.etag?.takeIf { it.isNotBlank() }
            ?: modified.digest.takeIf { BootAssetPolicy.isImmutable(rawUrl) }
        if (!etag.isNullOrBlank() && !cancellation.isCancelled) {
            val ticket = store.beginWrite(key, epoch)
            if (ticket != null) {
                // A cancel that lands before the atomic rename discards this body instead of writing it.
                cancellation.onCancel { ticket.cancel() }
                try {
                    val stored = store.commit(ticket, etag, modified.contentType, modified.body, modified.digest)
                    // Nothing from a cancelled attempt may remain servable, even when the rename won
                    // the race with the cancellation.
                    if (stored && cancellation.isCancelled) store.remove(key)
                } finally {
                    store.abort(ticket)
                }
            }
        }
        if (cancellation.isCancelled) return decide(BootAssetOutcome.CANCELLED, started)
        return BootAssetDecision(
            outcome = BootAssetOutcome.MISS,
            result = Result.Body(modified.body, modified.contentType, modified.etag),
            bytesServed = modified.body.size.toLong(),
            bytesFetched = modified.body.size.toLong(),
            wireFetched = modified.wireBytes,
            durationMs = clock() - started,
        )
    }

    private fun decide(
        outcome: BootAssetOutcome,
        started: Long,
        wireFetched: Long = 0L,
    ): BootAssetDecision = BootAssetDecision(
        outcome = outcome,
        result = Result.Miss,
        wireFetched = wireFetched,
        durationMs = clock() - started,
    )

    /** JavaScript or CSS: the only mutable-free resources the policy may answer. */
    private fun isCacheableContentType(contentType: String): Boolean = when (
        contentType.substringBefore(';').trim().lowercase()
    ) {
        "text/javascript", "application/javascript", "text/css" -> true
        else -> false
    }
}

/**
 * The only bridge between the WebView and the cache.
 *
 * A miss, a disabled cache, a closed cache and any thrown error all return null, which leaves the
 * WebView's navigation, TLS, cookie and error handling exactly as upstream 0.8.1 has it.
 */
internal class BootAssetResponder(private val cache: BootAssetCache?) {
    internal data class Response(val body: ByteArray, val contentType: String, val etag: String?)

    val enabled: Boolean get() = cache != null

    fun response(method: String, isForMainFrame: Boolean, rawUrl: String): Response? {
        if (!enabled || method != "GET" || isForMainFrame) return null
        val body = runCatching { cache?.resolve(rawUrl) }.getOrNull() as? BootAssetCache.Result.Body ?: return null
        return Response(body.body, body.contentType, body.etag)
    }

    fun cancelInFlight() {
        runCatching { cache?.cancelInFlight() }
    }
}
