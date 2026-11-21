package io.github.sayach.dshmobile

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Staging ownership for one viewer file share: bounded reservations, unique
 * app-created directories, and lifetime rules that keep handed-off bytes
 * readable by the recipient after the chooser closes.
 *
 * The display name is validated to be a single safe path segment and becomes
 * the staged file's name inside an opaque per-transfer directory, so the
 * recipient sees the original name while no caller-supplied path is ever used.
 */
internal class ViewerShareStore(
    private val root: File,
    private val nowMillis: () -> Long,
    private val idFactory: () -> String,
    private val wallClockMillis: () -> Long = { System.currentTimeMillis() },
) {
    enum class RejectReason {
        NAME_INVALID, MIME_INVALID, LENGTH_INVALID, LENGTH_TOO_LARGE,
        ENTRIES_FULL, AGGREGATE_FULL, NOT_ACTIVE, OFFSET_MISMATCH,
        CHUNK_TOO_LARGE, OVERFLOW, LENGTH_MISMATCH, STORE_UNAVAILABLE, IO,
    }

    enum class Stage { ACTIVE, STAGED, HANDED_OFF }

    sealed class BeginResult {
        data class Opened(val transfer: Transfer) : BeginResult()
        data class Rejected(val reason: RejectReason) : BeginResult()
    }

    sealed class AppendResult {
        data class Ok(val nextOffset: Long) : AppendResult()
        data class Rejected(val reason: RejectReason) : AppendResult()
    }

    sealed class FinishResult {
        data class Staged(val file: File) : FinishResult()
        data class Rejected(val reason: RejectReason) : FinishResult()
    }

    data class SweepReport(val removed: Int)

    /** One reserved transfer; `stage == null` means it was removed and its files deleted. */
    inner class Transfer internal constructor(
        val id: String,
        val displayName: String,
        val mime: String,
        internal val declaredBytes: Long,
        internal val directory: File,
    ) {
        internal val file = File(directory, displayName)
        internal var stage: Stage? = Stage.ACTIVE
        internal var received = 0L
        internal var lastTouched = nowMillis()
        internal var handoffAt = 0L
        internal var stagedFile: File? = null

        /** Appends one decoded chunk at the next monotonic offset; rejects anything else without writing. */
        fun append(offset: Long, chunk: ByteArray): AppendResult = synchronized(lock) {
            if (stage != Stage.ACTIVE) return AppendResult.Rejected(RejectReason.NOT_ACTIVE)
            if (chunk.size > MAX_CHUNK_BYTES) return AppendResult.Rejected(RejectReason.CHUNK_TOO_LARGE)
            if (offset != received) return AppendResult.Rejected(RejectReason.OFFSET_MISMATCH)
            if (offset + chunk.size > declaredBytes) return AppendResult.Rejected(RejectReason.OVERFLOW)
            return try {
                FileOutputStream(file, true).use { it.write(chunk) }
                received += chunk.size
                lastTouched = nowMillis()
                directory.setLastModified(wallClockMillis())
                AppendResult.Ok(received)
            } catch (_: IOException) {
                terminate()
                AppendResult.Rejected(RejectReason.IO)
            }
        }

        /** Verifies the exact declared length; a mismatch drops the partial file. */
        fun finish(): FinishResult = synchronized(lock) {
            if (stage != Stage.ACTIVE) return FinishResult.Rejected(RejectReason.NOT_ACTIVE)
            if (received != declaredBytes) {
                terminate()
                return FinishResult.Rejected(RejectReason.LENGTH_MISMATCH)
            }
            // A declared-empty transfer never opened a stream; materialize it now.
            if (!file.isFile && !(file.createNewFile() || file.isFile)) {
                terminate()
                return FinishResult.Rejected(RejectReason.IO)
            }
            stage = Stage.STAGED
            stagedFile = file
            lastTouched = nowMillis()
            directory.setLastModified(wallClockMillis())
            FinishResult.Staged(file)
        }

        /** Records a launched chooser; handed-off bytes are never deleted by later cancellation. */
        fun markHandedOff(): Boolean = synchronized(lock) {
            if (stage != Stage.STAGED) return false
            stage = Stage.HANDED_OFF
            handoffAt = nowMillis()
            lastTouched = handoffAt
            persistHandedOffMarker(wallClockMillis())
            true
        }

        /** Idempotent sender cancellation; an already handed-off attachment is not withdrawn. */
        fun cancel(): Boolean = synchronized(lock) {
            if (stage == Stage.HANDED_OFF || stage == null) return stage == null
            terminate()
            true
        }

        /** A failed chooser launch releases the reservation and the staged file. */
        fun failLaunch(): Boolean = synchronized(lock) {
            if (stage != Stage.ACTIVE && stage != Stage.STAGED) return false
            terminate()
            true
        }
    }

    private data class CommittedEntry(val handoffWallMillis: Long, val bytes: Long)

    private val lock = Any()
    private val entries = LinkedHashMap<String, Transfer>()
    private val committed = LinkedHashMap<String, CommittedEntry>()

    init {
        sweep()
    }

    /** Reserves one bounded transfer after sweeping expired work; never evicts unexpired attachments. */
    fun begin(displayName: String, mime: String, byteLength: Long): BeginResult = synchronized(lock) {
        sweep()
        if (displayName.isBlank() || displayName.length > MAX_NAME_CHARS || displayName == "." || displayName == ".."
            || displayName == HANDED_OFF_MARKER
            || displayName.any { it == '/' || it == '\\' || it.isISOControl() }
        ) return BeginResult.Rejected(RejectReason.NAME_INVALID)
        if (!MIME_PATTERN.matches(mime)) return BeginResult.Rejected(RejectReason.MIME_INVALID)
        if (byteLength < 0L) return BeginResult.Rejected(RejectReason.LENGTH_INVALID)
        if (byteLength > MAX_FILE_BYTES) return BeginResult.Rejected(RejectReason.LENGTH_TOO_LARGE)
        if (entryCount() >= MAX_ENTRIES) return BeginResult.Rejected(RejectReason.ENTRIES_FULL)
        if (usedBytes() + byteLength > MAX_AGGREGATE_BYTES) return BeginResult.Rejected(RejectReason.AGGREGATE_FULL)
        val staging = File(root, DIRECTORY_NAME)
        if (!staging.isDirectory && !staging.mkdirs()) return BeginResult.Rejected(RejectReason.STORE_UNAVAILABLE)
        val id = idFactory()
        val directory = File(staging, id)
        if (!directory.mkdir()) return BeginResult.Rejected(RejectReason.STORE_UNAVAILABLE)
        directory.setLastModified(wallClockMillis())
        val transfer = Transfer(id, displayName, mime, byteLength, directory)
        entries[transfer.id] = transfer
        BeginResult.Opened(transfer)
    }

    /** Removes idle incomplete transfers, expired handed-off attachments, and stray directories. */
    fun sweep(): SweepReport = synchronized(lock) {
        val monoNow = nowMillis()
        val wallNow = wallClockMillis()
        var removed = 0
        val expired = entries.values.filter { transfer ->
            when (transfer.stage) {
                Stage.HANDED_OFF -> monoNow - transfer.handoffAt > HANDED_OFF_RETENTION_MS
                null -> false
                else -> monoNow - transfer.lastTouched > IDLE_EXPIRY_MS
            }
        }
        for (transfer in expired) {
            transfer.terminate()
            removed++
        }
        val staging = File(root, DIRECTORY_NAME)
        val expiredCommitted = committed.entries.filter { (dirName, entry) ->
            val dir = File(staging, dirName)
            !dir.isDirectory || (entry.handoffWallMillis > 0L && wallNow - entry.handoffWallMillis > HANDED_OFF_RETENTION_MS)
        }
        for ((dirName, _) in expiredCommitted) {
            val dir = File(staging, dirName)
            val deleted = dir.isDirectory && dir.deleteRecursively()
            if (!dir.exists()) {
                committed.remove(dirName)
                if (deleted) removed++
            }
        }
        val live = entries.values.map { it.directory.name }.toSet()
        staging.listFiles()?.forEach { directory ->
            if (!directory.isDirectory || directory.name in live || directory.name in committed) return@forEach
            val marker = File(directory, HANDED_OFF_MARKER)
            if (marker.isFile) {
                val handoffWall = readMarkerTimestamp(marker)
                    ?: marker.lastModified().takeIf { it > 0L }
                    ?: directory.lastModified()
                val stale = handoffWall > 0L && wallNow - handoffWall > HANDED_OFF_RETENTION_MS
                if (stale) {
                    if (directory.deleteRecursively()) removed++
                } else {
                    committed[directory.name] = CommittedEntry(handoffWall, directoryStagedBytes(directory))
                }
            } else {
                val modified = directory.lastModified()
                val stale = modified > 0L && wallNow - modified > IDLE_EXPIRY_MS
                if (stale && directory.deleteRecursively()) removed++
            }
        }
        SweepReport(removed)
    }

    fun usedBytes(): Long = synchronized(lock) {
        entries.values.sumOf { it.declaredBytes } + committed.values.sumOf { it.bytes }
    }

    fun entryCount(): Int = synchronized(lock) { entries.size + committed.size }

    private fun directoryStagedBytes(directory: File): Long =
        directory.listFiles()
            ?.filter { it.isFile && it.name != HANDED_OFF_MARKER }
            ?.sumOf { it.length() }
            ?: 0L

    private fun Transfer.persistHandedOffMarker(wallNow: Long) {
        val marker = File(directory, HANDED_OFF_MARKER)
        try {
            marker.writeText(wallNow.toString())
            marker.setLastModified(wallNow)
            directory.setLastModified(wallNow)
        } catch (_: IOException) {
            // Chooser launch already succeeded; best-effort persistence only.
        }
    }

    private fun readMarkerTimestamp(marker: File): Long? = try {
        marker.readText().trim().toLongOrNull()?.takeIf { it > 0L }
    } catch (_: IOException) {
        null
    }

    private fun Transfer.terminate() {
        entries.remove(id)
        stage = null
        directory.deleteRecursively()
    }

    companion object {
        private const val MAX_NAME_CHARS = 200
        private const val HANDED_OFF_MARKER = ".handed-off"
        private val MIME_PATTERN = Regex("^[!-~]{1,96}/[!-~]{1,96}$")
        const val DIRECTORY_NAME = "viewer-share"
        const val MAX_FILE_BYTES = NativeBridgePolicy.MAX_BINARY_BYTES.toLong()
        const val MAX_AGGREGATE_BYTES = 32L * 1024 * 1024
        const val MAX_ENTRIES = 32
        const val MAX_CHUNK_BYTES = 192 * 1024
        const val IDLE_EXPIRY_MS = 2L * 60 * 1000
        const val HANDED_OFF_RETENTION_MS = 24L * 60 * 60 * 1000
    }
}
