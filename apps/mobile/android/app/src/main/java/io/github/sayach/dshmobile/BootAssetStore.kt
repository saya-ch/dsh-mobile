package io.github.sayach.dshmobile

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import org.json.JSONObject

/**
 * Largest body this cache may hold.
 *
 * Boot batches stay far below this. A plugin combo bundle is the outlier: one measured combo is
 * 19,107,568 decoded bytes from a 5,168,468-byte gzip transfer, because it concatenates dozens of
 * modules. The ceiling is a memory guard, not a policy: a response above it falls back to the
 * WebView instead of being buffered whole.
 */
internal const val MAX_BOOT_ASSET_BYTES = 24L * 1024 * 1024

/** Default on-disk budget shared by every stored boot batch. */
internal const val DEFAULT_BOOT_ASSET_QUOTA_BYTES = 64L * 1024 * 1024

/** Default number of stored batches; the gateway emits a handful of revisioned batches per layout. */
internal const val DEFAULT_BOOT_ASSET_ENTRIES = 24

/** Content digest of one batch body; recorded on write and re-checked before any read is served. */
internal object BootAssetDigest {
    private const val HEX = "0123456789abcdef"

    fun of(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val out = StringBuilder(digest.size * 2)
        for (byte in digest) {
            val value = byte.toInt() and 0xff
            out.append(HEX[value ushr 4]).append(HEX[value and 0x0f])
        }
        return out.toString()
    }

    /** Hashes an arbitrary key so a stored body never derives its file name from the URL. */
    fun ofKey(value: String): String = of(value.toByteArray(Charsets.UTF_8))
}

/**
 * On-disk copies of revisioned boot batches, bounded by [quotaBytes] and [maxEntries] and evicted
 * least-recently-used.
 *
 * A URL is only a module-selection key: the gateway can reassemble the same path when its layout
 * file changes, so every entry keeps the response validator and every hit revalidates.
 *
 * Durability and isolation rules:
 * - A body is accepted only when its size and SHA-256 digest match the fetched transfer; the digest
 *   is re-verified on every read, so a truncated or tampered file is a miss and is deleted.
 * - Writes go to `.part`, are fsynced, then atomically renamed: a crash never leaves a servable
 *   half-body, and an interrupted `.part` is pruned on the next open.
 * - [epoch] is bumped by [clear]. A writer reserves a key with [beginWrite] against the epoch it saw
 *   before its download started, so a body whose download straddled a clear (or a key that was
 *   evicted while the download ran) is discarded instead of written back. Only one writer may
 *   reserve a key at a time.
 * - [clear] marks every entry stale and deletes only the files no reader currently holds through
 *   [acquire]; the rest are deleted when the last lease is released, and the bumped epoch refuses
 *   every commit that was in flight.
 */
internal class BootAssetStore(
    private val directory: File,
    private val quotaBytes: Long = DEFAULT_BOOT_ASSET_QUOTA_BYTES,
    private val maxEntries: Int = DEFAULT_BOOT_ASSET_ENTRIES,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** One indexed batch. [leases] counts readers that must finish before the file may disappear. */
    internal data class Entry(
        val key: String,
        val etag: String,
        val contentType: String,
        val size: Long,
        val digest: String,
        val lastUsedAt: Long,
        val leases: Int,
    )

    /** A body a reader holds; the file behind it survives [clear] until [close]. */
    internal inner class Lease internal constructor(
        val entry: Entry,
        val body: ByteArray,
    ) : AutoCloseable {
        private val key = entry.key
        private var released = false

        override fun close() {
            if (released) return
            released = true
            releaseLease(key)
        }
    }

    /** Exclusive right to write one key while the store epoch and that key's version stay put. */
    internal class WriteTicket internal constructor(
        internal val key: String,
        internal val epoch: Long,
        internal val version: Long,
    ) {
        @Volatile
        internal var cancelled: Boolean = false

        /** Marks the reservation abandoned; the matching commit then discards its body. */
        internal fun cancel() {
            cancelled = true
        }
    }

    private class Slot(
        val key: String,
        val etag: String,
        val contentType: String,
        val size: Long,
        val digest: String,
        var lastUsedAt: Long,
    ) {
        var leases: Int = 0
        var stale: Boolean = false

        fun snapshot(): Entry = Entry(key, etag, contentType, size, digest, lastUsedAt, leases)
    }

    private val indexFile = File(directory, INDEX_FILE)
    private val slots = mutableMapOf<String, Slot>()
    private val keyVersions = mutableMapOf<String, Long>()
    private val writers = mutableSetOf<String>()
    private var loaded = false
    private var totalBytes = 0L
    private var epoch = 0L

    /** Monotonic generation; [clear] is the only thing that advances it. */
    @Synchronized
    fun currentEpoch(): Long {
        ensureLoaded()
        return epoch
    }

    /** Returns the stored metadata for [key] without touching its recency. */
    @Synchronized
    fun entry(key: String): Entry? {
        ensureLoaded()
        return slots[key]?.takeUnless { it.stale }?.snapshot()
    }

    /**
     * Reads a complete, verified body and holds the entry until [Lease.close]. A size or digest
     * mismatch, a missing file or a cleared entry is a miss and drops the entry.
     */
    @Synchronized
    fun acquire(key: String): Lease? {
        ensureLoaded()
        val slot = slots[key] ?: return null
        if (slot.stale) {
            deleteLocked(key)
            persistIndexLocked()
            return null
        }
        slot.leases += 1
        val bytes = runCatching { bodyFile(key).readBytes() }.getOrNull()
        if (bytes == null || bytes.size.toLong() != slot.size || BootAssetDigest.of(bytes) != slot.digest) {
            // A truncated or tampered body is never served; drop it while this read still holds it.
            slot.stale = true
            releaseLeaseLocked(key)
            return null
        }
        return Lease(slot.snapshot(), bytes)
    }

    @Synchronized
    fun releaseLease(key: String) {
        ensureLoaded()
        releaseLeaseLocked(key)
    }

    /** Records a successful hit. The index is flushed by the next write; LRU survives restarts approximately. */
    @Synchronized
    fun markUsed(key: String) {
        ensureLoaded()
        val slot = slots[key]?.takeUnless { it.stale } ?: return
        slot.lastUsedAt = clock()
    }

    /**
     * Reserves [key] for one writer, or returns null when the epoch moved since [expectedEpoch],
     * another download already owns the key, or a concurrent write/evict changed its version.
     */
    @Synchronized
    fun beginWrite(key: String, expectedEpoch: Long): WriteTicket? {
        ensureLoaded()
        if (expectedEpoch != epoch) return null
        if (!writers.add(key)) return null
        return WriteTicket(key, epoch, keyVersions[key] ?: 0L)
    }

    /**
     * Writes one verified body atomically and makes it servable. Returns false — and stores nothing —
     * when the reservation is stale, the epoch moved, the key was evicted, or the body contradicts
     * its declared size or digest.
     */
    @Synchronized
    fun commit(ticket: WriteTicket, etag: String, contentType: String, body: ByteArray, digest: String): Boolean {
        try {
            if (ticket.cancelled) return false
            if (ticket.epoch != epoch) return false
            if ((keyVersions[ticket.key] ?: 0L) != ticket.version) return false
            if (etag.isBlank() || body.isEmpty()) return false
            if (body.size > MAX_BOOT_ASSET_BYTES || body.size > quotaBytes) return false
            if (BootAssetDigest.of(body) != digest) return false
            if (!directory.isDirectory && !directory.mkdirs()) return false
            if (!writeAtomically(bodyFile(ticket.key), body)) return false
            val previous = slots[ticket.key]
            if (previous != null) totalBytes -= previous.size
            slots[ticket.key] = Slot(
                key = ticket.key,
                etag = etag,
                contentType = contentType,
                size = body.size.toLong(),
                digest = digest,
                lastUsedAt = clock(),
            ).also { it.leases = previous?.leases ?: 0 }
            totalBytes += body.size
            keyVersions[ticket.key] = (keyVersions[ticket.key] ?: 0L) + 1L
            evictLocked(keep = ticket.key)
            persistIndexLocked()
            return true
        } finally {
            writers.remove(ticket.key)
        }
    }

    /** Abandons a reservation without writing anything. */
    @Synchronized
    fun abort(ticket: WriteTicket) {
        ticket.cancel()
        writers.remove(ticket.key)
    }

    /** Drops one entry; the body file is deleted even when the index never knew it. */
    @Synchronized
    fun remove(key: String) {
        ensureLoaded()
        deleteLocked(key)
        persistIndexLocked()
    }

    /**
     * Advances the epoch and deletes every cached body that no reader holds; a held body is deleted
     * when its lease closes. Returns the new epoch so callers can log or assert the generation.
     */
    @Synchronized
    fun clear(): Long {
        ensureLoaded()
        epoch += 1L
        slots.values.forEach { it.stale = true }
        slots.values.filter { it.leases == 0 }.forEach { deleteLocked(it.key) }
        totalBytes = slots.values.sumOf { it.size }
        pruneUnreferencedFilesLocked()
        persistIndexLocked()
        return epoch
    }

    private fun releaseLeaseLocked(key: String) {
        val slot = slots[key] ?: return
        slot.leases = maxOf(0, slot.leases - 1)
        if (slot.leases == 0 && slot.stale) {
            deleteLocked(key)
            persistIndexLocked()
        }
    }

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        val stored = runCatching { JSONObject(indexFile.readText()) }
            .getOrNull()
            ?.takeIf { it.optInt("version", 0) == INDEX_VERSION }
            ?.optJSONObject("entries")
        stored?.keys()?.forEach { key ->
            val row = stored.optJSONObject(key) ?: return@forEach
            val etag = row.optString("etag").takeIf { it.isNotBlank() } ?: return@forEach
            val digest = row.optString("digest").takeIf { it.isNotBlank() } ?: return@forEach
            val size = row.optLong("size", -1L)
            val file = bodyFile(key)
            if (size <= 0L || size > MAX_BOOT_ASSET_BYTES || !file.isFile || file.length() != size) return@forEach
            slots[key] = Slot(
                key = key,
                etag = etag,
                contentType = row.optString("contentType", DEFAULT_CONTENT_TYPE),
                size = size,
                digest = digest,
                lastUsedAt = row.optLong("lastUsedAt", 0L),
            )
            totalBytes += size
        }
        pruneUnreferencedFilesLocked()
    }

    /** Drops bodies the index does not reference, stale copies and any interrupted `.part` write. */
    private fun pruneUnreferencedFilesLocked() {
        val referenced = slots.keys.mapTo(HashSet()) { bodyFile(it).name }
        directory.listFiles()?.forEach { file ->
            if (file.name.endsWith(PART_SUFFIX) || (file.name.endsWith(BODY_SUFFIX) && file.name !in referenced)) {
                file.delete()
            }
        }
    }

    private fun evictLocked(keep: String) {
        while (totalBytes > quotaBytes || slots.size > maxEntries) {
            val candidate = oldestCandidateLocked(keep) ?: return
            deleteLocked(candidate.key)
        }
    }

    /** The least recently used entry that is neither the incoming body nor held by a reader. */
    private fun oldestCandidateLocked(keep: String): Slot? = slots.values
        .asSequence()
        .filter { it.key != keep && it.leases == 0 }
        .minByOrNull { it.lastUsedAt }

    private fun deleteLocked(key: String) {
        val slot = slots.remove(key)
        if (slot != null) totalBytes -= slot.size
        keyVersions[key] = (keyVersions[key] ?: 0L) + 1L
        bodyFile(key).delete()
    }

    private fun persistIndexLocked() {
        if (!directory.isDirectory && !directory.mkdirs()) return
        val rows = JSONObject()
        slots.values.filterNot { it.stale }.forEach { slot ->
            rows.put(slot.key, JSONObject().apply {
                put("etag", slot.etag)
                put("contentType", slot.contentType)
                put("size", slot.size)
                put("digest", slot.digest)
                put("lastUsedAt", slot.lastUsedAt)
            })
        }
        val body = JSONObject().apply {
            put("version", INDEX_VERSION)
            put("entries", rows)
        }.toString().toByteArray(Charsets.UTF_8)
        writeAtomically(indexFile, body)
    }

    private fun bodyFile(key: String): File = File(directory, BootAssetDigest.ofKey(key) + BODY_SUFFIX)

    private fun writeAtomically(target: File, bytes: ByteArray): Boolean {
        val part = File(target.parentFile, "${target.name}$PART_SUFFIX")
        val written = runCatching {
            FileOutputStream(part).use { output ->
                output.write(bytes)
                output.flush()
                output.fd.sync()
            }
        }.isSuccess
        if (!written) {
            part.delete()
            return false
        }
        return runCatching {
            Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }.recoverCatching {
            // A filesystem without atomic moves still replaces the target; the partial file is gone.
            Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }.onFailure {
            part.delete()
        }.isSuccess
    }

    private companion object {
        const val BODY_SUFFIX = ".bin"
        const val PART_SUFFIX = ".part"
        const val INDEX_FILE = "index.json"
        const val INDEX_VERSION = 2
        const val DEFAULT_CONTENT_TYPE = "text/javascript"
    }
}
