package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The store is the only component that touches disk; these tests pin its bounds and durability rules. */
class BootAssetStoreTest {
    private fun temporaryDirectory(): File = kotlin.io.path.createTempDirectory("boot-assets").toFile()

    private fun body(size: Int, marker: Byte = 0x41): ByteArray = ByteArray(size) { marker }

    private fun bodyFiles(directory: File): List<File> =
        (directory.listFiles() ?: emptyArray()).filter { it.name.endsWith(".bin") }

    private fun storeInto(
        directory: File,
        quotaBytes: Long = 1_000,
        maxEntries: Int = 8,
        clock: () -> Long = { 1_000L },
    ): BootAssetStore = BootAssetStore(directory, quotaBytes = quotaBytes, maxEntries = maxEntries, clock = clock)

    private fun write(
        store: BootAssetStore,
        key: String,
        bytes: ByteArray,
        etag: String = "\"v1\"",
        contentType: String = "text/javascript",
    ): Boolean {
        val ticket = store.beginWrite(key, store.currentEpoch()) ?: return false
        return store.commit(ticket, etag, contentType, bytes, BootAssetDigest.of(bytes))
    }

    @Test
    fun storesAndReadsACompleteBodyWithItsValidatorAndDigest() {
        val directory = temporaryDirectory()
        try {
            var now = 1_000L
            val store = storeInto(directory, quotaBytes = 1_000, clock = { now })
            assertTrue(write(store, "key", body(4)))
            now = 2_000L
            store.markUsed("key")
            val entry = store.entry("key")
            assertEquals("\"v1\"", entry?.etag)
            assertEquals("text/javascript", entry?.contentType)
            assertEquals(4L, entry?.size)
            assertEquals(BootAssetDigest.of(body(4)), entry?.digest)
            assertEquals(2_000L, entry?.lastUsedAt)
            assertEquals(0, entry?.leases)
            val lease = store.acquire("key")
            assertNotNull(lease)
            lease!!.use { assertArrayEquals(body(4), it.body) }
            assertTrue((directory.listFiles() ?: emptyArray()).none { it.name.endsWith(".part") })
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun refusesACommitWhoseBodyContradictsItsDigest() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            val ticket = store.beginWrite("key", store.currentEpoch())!!
            assertFalse(store.commit(ticket, "\"v1\"", "text/javascript", body(4, 0x41), BootAssetDigest.of(body(4, 0x42))))
            assertNull(store.entry("key"))
            assertTrue(bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun evictsTheLeastRecentlyUsedEntryOnceTheQuotaIsExceeded() {
        val directory = temporaryDirectory()
        try {
            var now = 1_000L
            val store = storeInto(directory, quotaBytes = 100, clock = { now })
            assertTrue(write(store, "a", body(40)))
            now = 2_000L
            assertTrue(write(store, "b", body(40)))
            now = 3_000L
            assertTrue(write(store, "c", body(40)))

            assertNull(store.entry("a"))
            assertNull(store.acquire("a"))
            assertNotNull(store.acquire("b")?.use { assertArrayEquals(body(40), it.body) })
            assertNotNull(store.acquire("c")?.use { assertArrayEquals(body(40), it.body) })
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun evictsBeyondTheConfiguredEntryLimit() {
        val directory = temporaryDirectory()
        try {
            var now = 1_000L
            val store = storeInto(directory, quotaBytes = 10_000, maxEntries = 2, clock = { now })
            assertTrue(write(store, "a", body(4)))
            now = 2_000L
            assertTrue(write(store, "b", body(4)))
            now = 3_000L
            assertTrue(write(store, "c", body(4)))

            assertNull(store.entry("a"))
            assertNotNull(store.entry("b"))
            assertNotNull(store.entry("c"))
            assertEquals(2, bodyFiles(directory).size)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun refusesBodiesLargerThanTheConfiguredQuota() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory, quotaBytes = 100)
            assertFalse(write(store, "large", body(101)))
            assertNull(store.entry("large"))
            assertTrue(bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun ignoresACorruptIndexInsteadOfServingUnknownBytes() {
        val directory = temporaryDirectory()
        try {
            directory.mkdirs()
            File(directory, "index.json").writeText("{not json")
            val store = storeInto(directory)
            assertNull(store.entry("key"))
            assertTrue(write(store, "key", body(4)))
            assertNotNull(store.acquire("key"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun dropsAnEntryWhenItsBodyFileDisappeared() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            assertTrue(write(store, "key", body(4)))
            bodyFiles(directory).first().delete()
            assertNull(store.acquire("key"))
            assertNull(store.entry("key"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun dropsAnEntryWhoseBytesNoLongerMatchTheirDigest() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            assertTrue(write(store, "key", body(4, 0x41)))
            // Same length, different bytes: only the digest can tell this apart from the stored body.
            bodyFiles(directory).first().writeBytes(body(4, 0x42))

            assertNull(store.acquire("key"))
            assertNull(store.entry("key"))
            assertTrue(bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun dropsATruncatedBodyInsteadOfServingItsPrefix() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            assertTrue(write(store, "key", body(8)))
            bodyFiles(directory).first().writeBytes(body(4))

            assertNull(store.acquire("key"))
            assertNull(store.entry("key"))
            assertTrue(bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun removesInterruptedWritesAndBodiesTheIndexNeverReferenced() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            assertTrue(write(store, "key", body(4)))
            File(directory, "orphan.bin").writeBytes(body(8))
            File(directory, "leftover.bin.part").writeBytes(body(8))

            val reopened = storeInto(directory)

            assertNotNull(reopened.acquire("key"))
            assertFalse(File(directory, "orphan.bin").exists())
            assertFalse(File(directory, "leftover.bin.part").exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun clearRemovesBodiesAndIndex() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            assertTrue(write(store, "key", body(4)))
            store.clear()
            assertNull(store.entry("key"))
            assertTrue(bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun clearAdvancesTheEpochAndRefusesACommitThatStraddledIt() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            val epochBefore = store.currentEpoch()
            // The download starts, then the user clears site data while it is still running.
            val ticket = store.beginWrite("key", epochBefore)!!
            val epochAfter = store.clear()

            assertNotEquals(epochBefore, epochAfter)
            assertTrue(epochAfter > epochBefore)
            assertNull("A stale epoch cannot even reserve a key", store.beginWrite("key", epochBefore))
            assertFalse(store.commit(ticket, "\"v1\"", "text/javascript", body(4), BootAssetDigest.of(body(4))))
            assertNull(store.entry("key"))
            assertTrue(bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun aKeyEvictedDuringItsDownloadIsNotResurrected() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            assertTrue(write(store, "key", body(4)))
            val ticket = store.beginWrite("key", store.currentEpoch())!!
            store.remove("key")

            assertFalse(store.commit(ticket, "\"v2\"", "text/javascript", body(6), BootAssetDigest.of(body(6))))
            assertNull(store.entry("key"))
            assertTrue(bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun allowsOnlyOneWriterPerKey() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            val epoch = store.currentEpoch()
            val first = store.beginWrite("key", epoch)
            assertNotNull(first)
            assertNull(store.beginWrite("key", epoch))
            assertNotNull("Another key still has its own reservation", store.beginWrite("other", epoch))
            store.abort(first!!)
            assertNotNull(store.beginWrite("key", epoch))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun clearKeepsABodyAliveUntilTheReaderReleasesIt() {
        val directory = temporaryDirectory()
        try {
            val store = storeInto(directory)
            assertTrue(write(store, "key", body(4)))
            val lease = store.acquire("key")!!
            assertEquals(1, store.entry("key")?.leases)

            store.clear()

            // The entry is no longer servable, but the file the reader holds is not deleted under it.
            assertNull(store.entry("key"))
            assertEquals(1, bodyFiles(directory).size)
            lease.use { assertArrayEquals(body(4), it.body) }
            assertTrue("The file disappears with the last lease", bodyFiles(directory).isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }
}
