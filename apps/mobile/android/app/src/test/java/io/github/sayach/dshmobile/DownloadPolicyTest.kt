package io.github.sayach.dshmobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.file.Files

class DownloadPolicyTest {
    @Test
    fun keepsTheRealApkNameFromTheDshFileQueryWhenTheHeaderIsMissing() {
        val url = "https://gateway.example.test/api/file?sessionId=test&path=%2Fsleepy%2FSleepy%20%E8%AF%BE%E7%A8%8B%E8%A1%A8_1.0.57-ysu.6%2Bv1.0.6.apk"
        val filename = downloadFilename(url, null)
        assertEquals("Sleepy 课程表_1.0.57-ysu.6+v1.0.6.apk", filename)
        assertEquals("application/vnd.android.package-archive", downloadMimeType(filename, "application/octet-stream") {
            if (it == "apk") "application/vnd.android.package-archive" else null
        })
        assertEquals("header.apk", downloadFilename(url, "attachment; filename=\"header.apk\""))
        assertEquals("release.apk", workspaceDownloadFilename("https://gateway.example.test/api/file?path=C%3A%5Cbuild%5Crelease.apk"))
    }

    @Test
    fun ignoresFileQueryHintsOutsideTheDshFileRouteAndRejectsBadEncoding() {
        assertNull(workspaceDownloadFilename("https://gateway.example.test/download?path=%2Fprivate%2Ffile.apk"))
        assertNull(workspaceDownloadFilename("https://gateway.example.test/api/file?path=bad%ZZ.apk"))
        assertNull(workspaceDownloadFilename("https://gateway.example.test/api/file?path=%2Fdirectory%2F"))
        assertNull(workspaceDownloadFilename("https://gateway.example.test/api/file?path=.."))
        assertNull(workspaceDownloadFilename("https://gateway.example.test/api/file?other=file.apk"))
    }

    @Test
    fun keepsChineseApkFilenameFromAnInlinePreviewResponse() {
        val disposition = "inline; filename*=UTF-8''Sleepy%20%E8%AF%BE%E7%A8%8B%E8%A1%A8_1.0.57-ysu.6%2Bv1.0.6.apk"
        val filename = downloadFilenameFromContentDisposition(disposition)

        assertEquals("Sleepy 课程表_1.0.57-ysu.6+v1.0.6.apk", filename)
        assertEquals("application/vnd.android.package-archive", downloadMimeType(requireNotNull(filename), "application/octet-stream") {
            if (it == "apk") "application/vnd.android.package-archive" else null
        })
    }

    @Test
    fun prefersExtendedFilenameOverTheAsciiFallback() {
        assertEquals("课程表.apk", downloadFilenameFromContentDisposition(
            "attachment; filename=\"fallback.apk\"; filename*=UTF-8'zh-CN'%E8%AF%BE%E7%A8%8B%E8%A1%A8.apk",
        ))
    }

    @Test
    fun retainsQuotedFilenamesAndIgnoresDispositionCase() {
        assertEquals("Sleepy; table+release.apk", downloadFilenameFromContentDisposition(
            " INLINE ; filename=\"Sleepy; table+release.apk\"",
        ))
    }

    @Test
    fun fallsBackFromMalformedExtendedFilenameWithoutCrashing() {
        assertEquals("fallback.apk", downloadFilenameFromContentDisposition(
            "attachment; filename=\"fallback.apk\"; filename*=UTF-8''bad%ZZ.apk",
        ))
        assertNull(downloadFilenameFromContentDisposition("attachment; filename*=invalid''name.apk"))
        assertNull(downloadFilenameFromContentDisposition("attachment; filename=\"\""))
        assertNull(downloadFilenameFromContentDisposition(null))
    }

    @Test
    fun infersMissingOrGenericMimeTypesFromTheFilenameExtension() {
        for (reported in listOf(null, "", "invalid", " APPLICATION/OCTET-STREAM ; charset=binary")) {
            assertEquals("application/vnd.android.package-archive", downloadMimeType("release.APK", reported) {
                assertEquals("apk", it)
                "application/vnd.android.package-archive"
            })
        }
        assertEquals("application/zip", downloadMimeType("files.zip", null) { "application/zip" })
    }

    @Test
    fun preservesSpecificResponseMimeTypesAndUnknownFileExtensions() {
        assertEquals("application/pdf", downloadMimeType("file.apk", " Application/PDF; charset=binary") {
            error("A specific response MIME type must not be guessed again")
        })
        assertEquals("application/octet-stream", downloadMimeType("file.unknown", null) { null })
        assertEquals("application/octet-stream", downloadMimeType("file.unknown", null) { "invalid\r\nheader" })
    }

    @Test
    fun copiesResponsesWithinTheLimit() {
        val output = ByteArrayOutputStream()

        assertEquals(4, copyDownloadAtMost(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), output, 4))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), output.toByteArray())
    }

    @Test
    fun rejectsResponsesOverTheLimitBeforeWritingTheOverflowingChunk() {
        val output = ByteArrayOutputStream()

        assertThrows(IOException::class.java) {
            copyDownloadAtMost(ByteArrayInputStream(ByteArray(DEFAULT_BUFFER_SIZE + 1)), output, DEFAULT_BUFFER_SIZE.toLong())
        }
        assertEquals(DEFAULT_BUFFER_SIZE, output.size())
    }

    @Test
    fun removesOnlyStaleDownloadStagingFiles() {
        val directory = Files.createTempDirectory("dsh-download-policy").toFile()
        try {
            val stale = directory.resolve("dsh-download-stale.tmp").apply { writeText("stale") }
            val fresh = directory.resolve("dsh-download-fresh.tmp").apply { writeText("fresh") }
            val unrelated = directory.resolve("other.tmp").apply { writeText("other") }
            stale.setLastModified(1_000)
            fresh.setLastModified(9_000)
            unrelated.setLastModified(1_000)

            cleanupStaleDownloadFiles(directory, now = 10_000, staleAgeMs = 5_000)

            assertFalse(stale.exists())
            assertTrue(fresh.exists())
            assertTrue(unrelated.exists())
        } finally {
            directory.deleteRecursively()
        }
    }
}
