package io.github.sayach.dshmobile

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ViewerShareStoreTest {
    private lateinit var root: File
    private var now = 1_000_000L
    private var wallNow = 1_700_000_000_000L
    private val ids = AtomicInteger(0)

    @Before fun setUp() {
        root = Files.createTempDirectory("viewer-share-test-").toFile()
    }

    @After fun tearDown() {
        root.deleteRecursively()
    }

    private fun store() = ViewerShareStore(root, { now }, { "t${ids.incrementAndGet()}" }, { wallNow })

    private fun begin(store: ViewerShareStore, name: String = "報告.xlsx", bytes: Long = 3, mime: String = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"): ViewerShareStore.Transfer {
        val result = store.begin(name, mime, bytes)
        assertTrue("begin rejected: $result", result is ViewerShareStore.BeginResult.Opened)
        return (result as ViewerShareStore.BeginResult.Opened).transfer
    }

    @Test fun beginAppendFinishHandsOffExactBytesUnderTheOriginalDisplayName() {
        val store = store()
        val transfer = begin(store)
        assertEquals(ViewerShareStore.AppendResult.Ok(3), transfer.append(0, byteArrayOf(1, 2, 3)))
        val staged = transfer.finish() as ViewerShareStore.FinishResult.Staged
        assertEquals(3, staged.file.length())
        assertTrue(staged.file.readBytes().contentEquals(byteArrayOf(1, 2, 3)))
        assertTrue(staged.file.absolutePath.startsWith(File(root, "viewer-share").absolutePath))
        assertNotEquals(File(root, "viewer-share"), staged.file.parentFile)
        assertEquals("報告.xlsx", staged.file.name)
        transfer.markHandedOff()
    }

    @Test fun emptyFileIsStagedAsAZeroByteEntry() {
        val store = store()
        val transfer = begin(store, bytes = 0)
        val staged = transfer.finish() as ViewerShareStore.FinishResult.Staged
        assertEquals(0, staged.file.length())
        assertTrue(staged.file.isFile)
    }

    @Test fun missingReorderedOrDuplicateChunksAreRejectedWithoutWriting() {
        val store = store()
        val transfer = begin(store, bytes = 3)
        assertTrue(transfer.append(3, byteArrayOf(4, 5, 6)) is ViewerShareStore.AppendResult.Rejected)
        assertTrue(transfer.append(0, byteArrayOf(1, 2, 3)) is ViewerShareStore.AppendResult.Ok)
        assertTrue(transfer.append(0, byteArrayOf(9, 9, 9)) is ViewerShareStore.AppendResult.Rejected)
        assertTrue(transfer.append(6, byteArrayOf(7)) is ViewerShareStore.AppendResult.Rejected)
        val staged = transfer.finish() as ViewerShareStore.FinishResult.Staged
        assertTrue(staged.file.readBytes().contentEquals(byteArrayOf(1, 2, 3)))
        assertTrue(staged.file.length() == 3L && transfer.finish() is ViewerShareStore.FinishResult.Rejected)
    }

    @Test fun oversizeChunkAndOverflowPastDeclaredLengthAreRejected() {
        val store = store()
        val transfer = begin(store, bytes = 192 * 1024 + 1)
        assertTrue(transfer.append(0, ByteArray(192 * 1024 + 1)) is ViewerShareStore.AppendResult.Rejected)
        assertTrue(transfer.append(0, ByteArray(192 * 1024)) is ViewerShareStore.AppendResult.Ok)
        assertTrue(transfer.append(192 * 1024, byteArrayOf(1, 2)) is ViewerShareStore.AppendResult.Rejected)
        assertTrue(transfer.cancel())
    }

    @Test fun invalidNameLengthOrMimeIsRejectedBeforeAnyDirectoryExists() {
        val store = store()
        assertTrue(store.begin("", "text/plain", 1) is ViewerShareStore.BeginResult.Rejected)
        assertTrue(store.begin(".handed-off", "text/plain", 1) is ViewerShareStore.BeginResult.Rejected)
        assertTrue(store.begin("a/../../tmp", "text/plain", 1) is ViewerShareStore.BeginResult.Rejected)
        assertTrue(store.begin("ok.txt", "", 1) is ViewerShareStore.BeginResult.Rejected)
        assertTrue(store.begin("ok.txt", "bad mime", 1) is ViewerShareStore.BeginResult.Rejected)
        assertTrue(store.begin("ok.txt", "text/plain", -1) is ViewerShareStore.BeginResult.Rejected)
        assertTrue(store.begin("ok.txt", "text/plain", ViewerShareStore.MAX_FILE_BYTES + 1) is ViewerShareStore.BeginResult.Rejected)
        val staging = File(root, "viewer-share")
        assertTrue(!staging.exists() || staging.listFiles()!!.isEmpty())
    }

    @Test fun handedOffBytesSurviveIdleSweepAndExpireOnlyAfterRetention() {
        val store = store()
        val transfer = begin(store, bytes = 2)
        transfer.append(0, byteArrayOf(8, 9))
        (transfer.finish() as ViewerShareStore.FinishResult.Staged).also { assertTrue(it.file.isFile) }
        transfer.markHandedOff()
        now += 3 * 60 * 1000
        assertEquals(0, store.sweep().removed)
        now += ViewerShareStore.HANDED_OFF_RETENTION_MS + 1
        assertEquals(1, store.sweep().removed)
        assertFalse(File(root, "viewer-share").listFiles()!!.isNotEmpty())
    }

    @Test fun idleIncompleteTransfersExpireAndReleaseTheirReservation() {
        val store = store()
        begin(store, bytes = ViewerShareStore.MAX_FILE_BYTES)
        now += ViewerShareStore.IDLE_EXPIRY_MS + 1
        assertEquals(1, store.sweep().removed)
        val reopened = begin(store, bytes = ViewerShareStore.MAX_FILE_BYTES)
        assertTrue(reopened.append(0, ByteArray(10)) is ViewerShareStore.AppendResult.Ok)
        reopened.cancel()
    }

    @Test fun aggregateQuotaBindsWithoutEvictingUnexpiredAttachments() {
        val store = store()
        repeat(4) { begin(store, name = "f$it.bin", bytes = ViewerShareStore.MAX_FILE_BYTES, mime = "application/octet-stream") }
        assertTrue(store.begin("f4.bin", "application/octet-stream", 1) is ViewerShareStore.BeginResult.Rejected)
        assertEquals(ViewerShareStore.BeginResult.Rejected(ViewerShareStore.RejectReason.AGGREGATE_FULL), store.begin("f5.bin", "application/octet-stream", 1))
    }

    @Test fun entryCountIncludesEmptyFilesAndBindsAtThirtyTwo() {
        val store = store()
        repeat(32) { begin(store, name = "e$it.bin", bytes = 0, mime = "application/octet-stream") }
        assertEquals(ViewerShareStore.BeginResult.Rejected(ViewerShareStore.RejectReason.ENTRIES_FULL), store.begin("e32.bin", "application/octet-stream", 0))
    }

    @Test fun cancellationIsIdempotentAndDropsPartialFiles() {
        val store = store()
        val transfer = begin(store, bytes = 10)
        transfer.append(0, ByteArray(10))
        assertTrue(transfer.cancel())
        assertTrue(transfer.cancel())
        assertTrue(File(root, "viewer-share").listFiles()!!.isEmpty())
        assertTrue(transfer.append(10, ByteArray(1)) is ViewerShareStore.AppendResult.Rejected)
    }

    @Test fun failedLaunchReleasesReservationAndStagingFile() {
        val store = store()
        val transfer = begin(store, bytes = ViewerShareStore.MAX_FILE_BYTES)
        transfer.append(0, ByteArray(16))
        assertTrue(transfer.failLaunch())
        assertEquals(0L, store.usedBytes())
        assertTrue(File(root, "viewer-share").listFiles()!!.isEmpty())
        begin(store, bytes = ViewerShareStore.MAX_FILE_BYTES)
    }

    @Test fun twoAttachmentsWithOneDisplayNameKeepDistinctBytes() {
        val store = store()
        val first = begin(store, bytes = 1).also {
            assertTrue(it.append(0, byteArrayOf(1)) is ViewerShareStore.AppendResult.Ok)
            assertTrue(it.finish() is ViewerShareStore.FinishResult.Staged)
        }
        val second = begin(store, bytes = 1).also {
            assertTrue(it.append(0, byteArrayOf(2)) is ViewerShareStore.AppendResult.Ok)
            assertTrue(it.finish() is ViewerShareStore.FinishResult.Staged)
        }
        assertNotEquals(first.id, second.id)
        assertNotEquals(first.directory, second.directory)
        assertEquals(first.displayName, second.displayName)
        assertTrue(first.stagedFile!!.readBytes().contentEquals(byteArrayOf(1)))
        assertTrue(second.stagedFile!!.readBytes().contentEquals(byteArrayOf(2)))
    }

    @Test fun concurrentBeginsNeverExceedTheEntryLimit() {
        val store = store()
        val workers = 40
        val accepted = AtomicInteger(0)
        val ready = CountDownLatch(workers)
        val go = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(workers)
        try {
            repeat(workers) {
                pool.submit {
                    ready.countDown()
                    go.await()
                    if (store.begin("c.bin", "application/octet-stream", 0) is ViewerShareStore.BeginResult.Opened) accepted.incrementAndGet()
                }
            }
            assertTrue("workers did not become ready", ready.await(10, java.util.concurrent.TimeUnit.SECONDS))
        } finally {
            go.countDown()
            pool.shutdown()
            assertTrue("pool did not terminate", pool.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS))
        }
        assertEquals(32, accepted.get())
        assertEquals(32, store.entryCount())
    }

    @Test fun recreatedStorePreservesHandedOffDirectoryPastIdleAndDeletesAfterRetention() {
        now = 10_000L
        val store1 = store()
        val transfer = begin(store1, name = "report.pdf", bytes = 2)
        assertTrue(transfer.append(0, byteArrayOf(4, 5)) is ViewerShareStore.AppendResult.Ok)
        val staged = transfer.finish() as ViewerShareStore.FinishResult.Staged
        assertTrue(transfer.markHandedOff())

        // Simulate activity rotation / process restart with a reset monotonic clock
        // and wall clock advanced well past the 2-minute idle expiry.
        now = 500L
        wallNow += 3 * 60 * 1000L
        val store2 = store()
        assertTrue("handed-off file should survive init sweep past 2 min", staged.file.isFile)

        val fresh = begin(store2, name = "next.pdf", bytes = 1)
        assertTrue("handed-off file should survive begin sweep past 2 min", staged.file.isFile)
        assertTrue(fresh.cancel())

        wallNow += ViewerShareStore.HANDED_OFF_RETENTION_MS
        val store3 = store()
        assertFalse("handed-off directory should be swept after 24 h retention", staged.file.exists())
        assertFalse("handed-off directory root should be removed", transfer.directory.exists())
        assertEquals(0, store3.entryCount())
    }

    @Test fun recreatedStoreCountsCommittedDirectoriesAgainstAggregateAndEntryQuotas() {
        val store1 = store()
        val fullChunk = ByteArray(ViewerShareStore.MAX_CHUNK_BYTES)
        val committedFiles = mutableListOf<File>()
        repeat(4) { index ->
            val transfer = begin(store1, name = "big-$index.bin", bytes = ViewerShareStore.MAX_FILE_BYTES, mime = "application/octet-stream")
            var offset = 0L
            while (offset < ViewerShareStore.MAX_FILE_BYTES) {
                val remaining = (ViewerShareStore.MAX_FILE_BYTES - offset).toInt()
                val slice = if (remaining >= fullChunk.size) fullChunk else ByteArray(remaining)
                assertTrue(transfer.append(offset, slice) is ViewerShareStore.AppendResult.Ok)
                offset += slice.size
            }
            val staged = transfer.finish() as ViewerShareStore.FinishResult.Staged
            committedFiles.add(staged.file)
            assertTrue(transfer.markHandedOff())
        }

        // Recreate store past idle expiry but within 24 h retention.
        now = 500L
        wallNow += 3 * 60 * 1000L
        val store2 = store()
        assertEquals(ViewerShareStore.MAX_AGGREGATE_BYTES, store2.usedBytes())
        assertEquals(4, store2.entryCount())
        assertEquals(
            ViewerShareStore.BeginResult.Rejected(ViewerShareStore.RejectReason.AGGREGATE_FULL),
            store2.begin("extra.bin", "application/octet-stream", 1L),
        )
        for (file in committedFiles) {
            assertTrue("committed file must remain untouched after quota rejection", file.isFile)
        }

        // Advancing past 24 h retention sweeps committed directories and shrinks the ledger.
        wallNow += ViewerShareStore.HANDED_OFF_RETENTION_MS
        assertEquals(4, store2.sweep().removed)
        assertEquals(0L, store2.usedBytes())
        assertEquals(0, store2.entryCount())

        // Also enforce the 32-entry cap across store recreation with zero-byte handed-off files.
        val emptyCommitted = mutableListOf<File>()
        repeat(ViewerShareStore.MAX_ENTRIES) { index ->
            val transfer = begin(store2, name = "empty-$index.bin", bytes = 0L, mime = "application/octet-stream")
            val staged = transfer.finish() as ViewerShareStore.FinishResult.Staged
            emptyCommitted.add(staged.file)
            assertTrue(transfer.markHandedOff())
        }
        now = 100L
        wallNow += 3 * 60 * 1000L
        val store3 = store()
        assertEquals(ViewerShareStore.MAX_ENTRIES, store3.entryCount())
        assertEquals(
            ViewerShareStore.BeginResult.Rejected(ViewerShareStore.RejectReason.ENTRIES_FULL),
            store3.begin("empty-32.bin", "application/octet-stream", 0L),
        )
        for (file in emptyCommitted) {
            assertTrue("committed empty file must remain untouched after entry-cap rejection", file.isFile)
        }
    }

    @Test fun unknownDirectoryWithoutMarkerOlderThanIdleIsSweptAtInitAndOnBegin() {
        now = 10_000L
        val staging = File(root, ViewerShareStore.DIRECTORY_NAME).apply { assertTrue(mkdirs()) }
        val strayAtInit = File(staging, "orphan-init").apply {
            assertTrue(mkdirs())
            assertTrue(File(this, "partial.bin").createNewFile())
            assertTrue(setLastModified(wallNow - ViewerShareStore.IDLE_EXPIRY_MS - 1))
        }

        val store = store()
        assertFalse("orphan older than 2 min must be swept at init", strayAtInit.exists())

        val strayLater = File(staging, "orphan-begin").apply {
            assertTrue(mkdirs())
            assertTrue(File(this, "partial.bin").createNewFile())
            assertTrue(setLastModified(wallNow))
        }
        val active = begin(store, name = "ok.bin", bytes = 1)
        assertTrue("recent unknown dir within 2 min must not be swept yet", strayLater.exists())
        assertTrue(active.cancel())

        wallNow += ViewerShareStore.IDLE_EXPIRY_MS + 1
        val afterExpiry = begin(store, name = "ok2.bin", bytes = 1)
        assertFalse("orphan older than 2 min must be swept on begin", strayLater.exists())
        assertTrue(afterExpiry.cancel())
    }

    @Test fun rejectedAppendFollowedByCancelReleasesPartialFileAndQuotaImmediately() {
        val store = store()
        val transfer = begin(store, bytes = ViewerShareStore.MAX_FILE_BYTES)
        assertTrue(transfer.append(1, byteArrayOf(9)) is ViewerShareStore.AppendResult.Rejected)
        assertEquals(ViewerShareStore.MAX_FILE_BYTES, store.usedBytes())

        assertTrue(transfer.cancel())
        assertTrue(transfer.cancel())
        assertEquals(0L, store.usedBytes())
        assertEquals(0, store.entryCount())
        assertTrue(File(root, ViewerShareStore.DIRECTORY_NAME).listFiles()!!.isEmpty())
    }
}
