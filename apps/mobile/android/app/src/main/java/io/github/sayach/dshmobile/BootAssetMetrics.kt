package io.github.sayach.dshmobile

/** The decision one boot-batch subresource request received. */
internal enum class BootAssetOutcome {
    /** A revalidated `304` answered the subresource from disk. */
    HIT,

    /** The batch was transferred because nothing usable was stored yet. */
    MISS,

    /** The gateway refused the session (`401`/`403`); the WebView keeps the request. */
    REJECTED,

    /** A transport, encoding or size violation; the WebView keeps the request. */
    FAILED,

    /** The page navigated away, the view was destroyed or the app exited mid-download. */
    CANCELLED,

    /** Another thread already owns this batch, or the request budget is saturated. */
    CONTENDED,
}

/**
 * One recorded decision.
 *
 * [path] is always the revisioned batch path the policy already accepted
 * (`/mobile-access/mobile-boot/<64 hex>.js`). Metrics deliberately carry no cookie, query string,
 * origin or session identifier, so a snapshot is safe to log and to paste into a report.
 */
internal data class BootAssetEvent(
    val outcome: BootAssetOutcome,
    val path: String,
    val bytesServed: Long,
    val durationMs: Long,
)

/**
 * Point-in-time counters for the device-benefit measurement.
 *
 * The three byte counters answer three different questions and must not be conflated:
 * - [bytesServed] — bytes handed to the WebView. A revalidated hit counts here, so this is "what the
 *   page received", not "what the network carried".
 * - [bytesFetched] — response-body bytes that actually crossed the network: the body of a `200` this
 *   cache downloaded, including the fresh copy that replaced a stale entry. A `304` transfers no body
 *   and adds nothing here.
 * - [bytesSaved] — bytes delivered from disk after a `304`, i.e. the transfer that did not happen.
 *
 * `bytesServed` is therefore the sum of the other two for the batches this cache answered
 * (`bytesServed == bytesFetched + bytesSaved`), which is what makes [savedPercent] meaningful.
 */
internal data class BootAssetSnapshot(
    val hits: Long = 0,
    val misses: Long = 0,
    val revalidated: Long = 0,
    val rejected: Long = 0,
    val failed: Long = 0,
    val cancelled: Long = 0,
    val contended: Long = 0,
    val bytesServed: Long = 0,
    val bytesFetched: Long = 0,
    val bytesSaved: Long = 0,
    val totalDurationMs: Long = 0,
    val maxDurationMs: Long = 0,
    val recent: List<BootAssetEvent> = emptyList(),
) {
    val requests: Long get() = hits + misses + rejected + failed + cancelled + contended

    /** Share of answered batches that reused a revalidated body, in whole percent. */
    val hitPercent: Int get() = percentOf(hits, hits + misses)

    /**
     * Share of the batch bytes in play that never crossed the network: `saved / (saved + fetched)`.
     *
     * Serving a hit also counts in [bytesServed], so that counter cannot be the denominator — a
     * 100% hit rate would report 50%. A cold load reports 0, a fully revalidated start reports 100.
     */
    val savedPercent: Int get() = percentOf(bytesSaved, bytesSaved + bytesFetched)

    val averageDurationMs: Long get() = if (requests == 0L) 0L else totalDurationMs / requests

    /** One logcat-safe line: counters only, no origin, cookie, query or session identifier. */
    fun summary(): String = buildString {
        append("boot-cache requests=").append(requests)
        append(" hits=").append(hits)
        append(" misses=").append(misses)
        append(" revalidated=").append(revalidated)
        append(" rejected=").append(rejected)
        append(" failed=").append(failed)
        append(" cancelled=").append(cancelled)
        append(" contended=").append(contended)
        append(" served=").append(bytesServed).append("B")
        append(" fetched=").append(bytesFetched).append("B")
        append(" saved=").append(bytesSaved).append("B")
        append(" hitPercent=").append(hitPercent)
        append(" savedPercent=").append(savedPercent)
        append(" avgMs=").append(averageDurationMs)
        append(" maxMs=").append(maxDurationMs)
        val last = recent.lastOrNull()
        if (last != null) {
            append(" last=").append(last.outcome.name).append(':').append(last.path).append(':').append(last.durationMs).append("ms")
        }
    }

    private fun percentOf(part: Long, whole: Long): Int =
        if (whole <= 0L) 0 else ((part * 100L) / whole).toInt()
}

/**
 * Thread-safe counters behind [BootAssetCache].
 *
 * The four defer conditions ask for device measurements; this is the only place that observes them,
 * and it stays a plain Kotlin object so the numbers can be asserted from JVM unit tests and printed
 * with [snapshot] on any device.
 */
internal class BootAssetMetrics(private val recentLimit: Int = DEFAULT_RECENT_LIMIT) {
    private val recent = ArrayDeque<BootAssetEvent>()
    private var hits = 0L
    private var misses = 0L
    private var revalidated = 0L
    private var rejected = 0L
    private var failed = 0L
    private var cancelled = 0L
    private var contended = 0L
    private var bytesServed = 0L
    private var bytesFetched = 0L
    private var bytesSaved = 0L
    private var totalDurationMs = 0L
    private var maxDurationMs = 0L

    @Synchronized
    fun record(
        outcome: BootAssetOutcome,
        path: String,
        bytesServed: Long = 0L,
        bytesFetched: Long = 0L,
        bytesSaved: Long = 0L,
        durationMs: Long = 0L,
    ) {
        when (outcome) {
            BootAssetOutcome.HIT -> hits += 1
            BootAssetOutcome.MISS -> misses += 1
            BootAssetOutcome.REJECTED -> rejected += 1
            BootAssetOutcome.FAILED -> failed += 1
            BootAssetOutcome.CANCELLED -> cancelled += 1
            BootAssetOutcome.CONTENDED -> contended += 1
        }
        this.bytesServed += bytesServed
        this.bytesFetched += bytesFetched
        this.bytesSaved += bytesSaved
        totalDurationMs += durationMs
        if (durationMs > maxDurationMs) maxDurationMs = durationMs
        if (recentLimit <= 0) return
        recent.addLast(BootAssetEvent(outcome, path, bytesServed, durationMs))
        while (recent.size > recentLimit) recent.removeFirst()
    }

    /** Counts one `304` answer; a hit is recorded separately because it also serves bytes. */
    @Synchronized
    fun recordRevalidated() {
        revalidated += 1
    }

    @Synchronized
    fun snapshot(): BootAssetSnapshot = BootAssetSnapshot(
        hits = hits,
        misses = misses,
        revalidated = revalidated,
        rejected = rejected,
        failed = failed,
        cancelled = cancelled,
        contended = contended,
        bytesServed = bytesServed,
        bytesFetched = bytesFetched,
        bytesSaved = bytesSaved,
        totalDurationMs = totalDurationMs,
        maxDurationMs = maxDurationMs,
        recent = recent.toList(),
    )

    @Synchronized
    fun reset() {
        hits = 0L
        misses = 0L
        revalidated = 0L
        rejected = 0L
        failed = 0L
        cancelled = 0L
        contended = 0L
        bytesServed = 0L
        bytesFetched = 0L
        bytesSaved = 0L
        totalDurationMs = 0L
        maxDurationMs = 0L
        recent.clear()
    }

    private companion object {
        const val DEFAULT_RECENT_LIMIT = 8
    }
}
