package io.github.sayach.dshmobile

import java.io.File

/** Thread-safe duplicate/capacity gate; entries live until their terminal reply. */
internal class PendingRequestRegistry<T>(private val maxPending: Int) {
    private val entries = LinkedHashMap<String, T>()

    @Synchronized
    fun reserve(requestId: String, value: T): Boolean {
        if (entries.containsKey(requestId) || entries.size >= maxPending) return false
        entries[requestId] = value
        return true
    }

    @Synchronized operator fun get(requestId: String): T? = entries[requestId]
    @Synchronized fun remove(requestId: String): T? = entries.remove(requestId)
    @Synchronized fun keys(): List<String> = entries.keys.toList()
    @Synchronized fun clear() = entries.clear()
}

/**
 * Camera-file deletion state. Callers mutate it only while holding requestLock,
 * which makes snapshot handoff and terminal cleanup one atomic ownership decision.
 */
internal class CameraCleanupOwnership<T> {
    private var snapshotExported = false
    private var deferredCleanup: T? = null

    fun markSnapshotExported() {
        snapshotExported = true
    }

    /** Returns the file the current Activity may delete now, or defers it to the snapshot owner. */
    fun onTerminal(file: T?): T? {
        if (file == null) return null
        if (!snapshotExported) return file
        deferredCleanup = file
        return null
    }

    /** Transfer a terminal file into a cleanup-only tombstone at configuration handoff. */
    fun takeDeferredForHandoff(): T? = deferredCleanup.also { deferredCleanup = null }

    /** A surviving Activity reclaimed ownership because no recreation consumed its snapshot. */
    fun onHostResumed(): T? {
        snapshotExported = false
        return deferredCleanup.also { deferredCleanup = null }
    }

    /** Final disposal owns every remaining local file; config disposal owns none. */
    fun onDispose(activeFile: T?, preserveForConfiguration: Boolean): List<T> {
        if (preserveForConfiguration) return emptyList()
        snapshotExported = false
        return listOfNotNull(activeFile, deferredCleanup).distinct().also { deferredCleanup = null }
    }
}

/** Single temporary provider grant owned by the active file-picker result. */
internal class TemporaryGrantOwnership<T> {
    private var grant: T? = null

    fun claim(value: T?) {
        if (value == null) return
        check(grant == null) { "temporary grant is already owned" }
        grant = value
    }

    /** Releases only the expected grant, so stale callbacks cannot revoke a newer result. */
    fun release(expected: T): T? {
        if (grant != expected) return null
        return grant.also { grant = null }
    }

    /** Releases the active grant when its request is abandoned without a matching callback. */
    fun releaseAny(): T? = grant.also { grant = null }
}

internal enum class RestoredOperationDisposition {
    CLEANUP_ONLY,
}

/** Restored operations never have a surviving page Promise and must not read payload providers. */
internal fun RestoredOperationDisposition.requiresPayloadRead(): Boolean = when (this) {
    RestoredOperationDisposition.CLEANUP_ONLY -> false
}

internal data class RestoredOperationCleanupPlan(
    val readPayload: Boolean,
    val revokeGrant: Boolean,
    val deleteCameraFile: Boolean,
)

internal fun restoredNoCallerCleanupPlan(hasCameraFile: Boolean, hasCameraGrant: Boolean) =
    RestoredOperationCleanupPlan(
        readPayload = false,
        revokeGrant = hasCameraGrant,
        deleteCameraFile = hasCameraFile,
    )

/** Pure validation helpers shared by the Android bridge and local JVM tests. */
internal object NativeBridgePolicy {
    // Kept as a stable release-audit marker: inbound WebMessage payload limit.
    const val MAX_MESSAGE_BYTES = 1024 * 1024
    const val MAX_BINARY_BYTES = 8 * 1024 * 1024
    const val MAX_CLIPBOARD_BYTES = 256 * 1024
    const val MAX_REPLY_BYTES = 12 * 1024 * 1024
    const val ACTIVITY_REQUEST_TIMEOUT_MS = 5L * 60L * 1000L
    const val PAGE_ACTIVITY_TIMEOUT_MS = ACTIVITY_REQUEST_TIMEOUT_MS + 5_000L
    const val CAMERA_ORPHAN_MAX_AGE_MS = 24L * 60L * 60L * 1000L

    /** Keep the original deadline across recreation; old snapshots without one receive a fresh bound. */
    fun resolveActivityDeadline(storedDeadlineMillis: Long, nowMillis: Long): Long =
        storedDeadlineMillis.takeIf { it > 0L } ?: nowMillis + ACTIVITY_REQUEST_TIMEOUT_MS

    fun remainingActivityTimeout(deadlineMillis: Long, nowMillis: Long): Long =
        (deadlineMillis - nowMillis).coerceAtLeast(0L)

    /** Counts UTF-8 bytes without allocating another potentially large byte array. */
    fun isMessageWithinLimit(raw: String, limit: Int = MAX_MESSAGE_BYTES): Boolean {
        var bytes = 0
        var index = 0
        while (index < raw.length) {
            val first = raw[index]
            val increment = when {
                first.code <= 0x7f -> 1
                first.code <= 0x7ff -> 2
                Character.isHighSurrogate(first) && index + 1 < raw.length &&
                    Character.isLowSurrogate(raw[index + 1]) -> {
                    index += 1
                    4
                }
                Character.isSurrogate(first) -> 1 // UTF-8 encoder replacement byte for malformed UTF-16.
                else -> 3
            }
            bytes += increment
            if (bytes > limit) return false
            index += 1
        }
        return true
    }

    fun isTrustedMessage(origin: GatewayOrigin, sourceOrigin: String, isMainFrame: Boolean): Boolean =
        isMainFrame && GatewayOrigin.parse(sourceOrigin) == origin

    fun isStaleCameraOrphan(
        file: File,
        activeFile: File?,
        nowMillis: Long,
        maxAgeMillis: Long = CAMERA_ORPHAN_MAX_AGE_MS,
    ): Boolean {
        if (!file.isFile || !file.name.startsWith("dsh-camera-")) return false
        if (activeFile != null && runCatching { file.canonicalFile == activeFile.canonicalFile }.getOrDefault(false)) return false
        val modified = file.lastModified()
        return modified > 0L && modified <= nowMillis - maxAgeMillis
    }

    // Stable task-notification identifiers shared by the bridge and the release checker.
    const val TASK_NOTIFICATION_CHANNEL_ID = "dsh_task_completion"
    const val TASK_NOTIFICATION_ID = 7101
    const val TASK_NOTIFICATION_TITLE_CHARS = 80
    const val TASK_NOTIFICATION_BODY_CHARS = 200
    const val TASK_NOTIFICATION_TAG_CHARS = 64

    /** Bound page-supplied notification text: trimmed, single-line, control-free. */
    fun sanitizeNotificationField(value: String, maxChars: Int): String {
        val singleLine = value.replace(Regex("[\\r\\n]+"), " ")
        val printable = singleLine.filter { !it.isISOControl() }
        return printable.trim().take(maxChars)
    }

    /** Bound notification tag to lowercase slugs; unusable input falls back to a constant. */
    fun sanitizeNotificationTag(value: String): String {
        val slug = value.lowercase()
            .replace(Regex("[^a-z0-9-]+"), "-")
            .trim('-')
            .take(TASK_NOTIFICATION_TAG_CHARS)
        return slug.ifEmpty { "dsh-task" }
    }
}
