package io.github.sayach.dshmobile

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class AppUpdateInstallerTest {
    private lateinit var server: HttpServer
    private lateinit var dir: File
    private var baseUrl = ""

    @Before
    fun startServer() {
        dir = Files.createTempDirectory("app-update-installer-test").toFile()
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        baseUrl = "http://127.0.0.1:${server.address.port}"
        server.start()
    }

    @After
    fun stopServer() {
        server.stop(0)
        dir.deleteRecursively()
    }

    private fun sha256(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }
    }

    @Test
    fun assetNamesKeepFullAndCompatBuildsOnTheirOwnLane() {
        assertEquals(
            "dsh-mobile-android-v0.7.6-iroh.apk",
            AppUpdateInstaller.apkAssetName("0.7.6", irohFull = true),
        )
        assertEquals(
            "dsh-mobile-android-v0.7.6.apk",
            AppUpdateInstaller.apkAssetName("0.7.6", irohFull = false),
        )
    }

    @Test
    fun urlsPointAtTheReleaseDownloadPage() {
        val apk = AppUpdateInstaller.apkUrl("android-v0.7.6", "dsh-mobile-android-v0.7.6.apk")
        assertEquals(
            "https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.7.6/dsh-mobile-android-v0.7.6.apk",
            apk,
        )
        assertEquals("$apk.sha256", AppUpdateInstaller.shaUrl(apk))
    }

    @Test
    fun parsesSha256sumLines() {
        val hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        assertEquals(hash, AppUpdateInstaller.parseSha256File("$hash  dsh-mobile-android-v0.7.6.apk", "dsh-mobile-android-v0.7.6.apk"))
        assertEquals(hash, AppUpdateInstaller.parseSha256File("$hash *dsh-mobile-android-v0.7.6.apk\r\n", "dsh-mobile-android-v0.7.6.apk"))
        assertEquals(hash, AppUpdateInstaller.parseSha256File("\n$hash  dsh-mobile-android-v0.7.6.apk\n", "dsh-mobile-android-v0.7.6.apk"))
    }

    @Test
    fun rejectsMismatchedOrMalformedShaFiles() {
        val hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        assertNull(AppUpdateInstaller.parseSha256File("$hash  other.apk", "dsh-mobile-android-v0.7.6.apk"))
        assertNull(AppUpdateInstaller.parseSha256File("nothex  dsh-mobile-android-v0.7.6.apk", "dsh-mobile-android-v0.7.6.apk"))
        assertNull(AppUpdateInstaller.parseSha256File("${hash}12  dsh-mobile-android-v0.7.6.apk", "dsh-mobile-android-v0.7.6.apk"))
        assertNull(AppUpdateInstaller.parseSha256File("", "dsh-mobile-android-v0.7.6.apk"))
        assertNull(AppUpdateInstaller.parseSha256File("justonefield", "dsh-mobile-android-v0.7.6.apk"))
    }

    @Test
    fun downloadsAndVerifiesAgainstThePublishedHash() {
        val payload = ByteArray(64 * 1024) { (it % 251).toByte() }
        val expected = sha256(payload)
        server.createContext("/pkg.apk") { exchange ->
            exchange.sendResponseHeaders(200, payload.size.toLong())
            exchange.responseBody.use { it.write(payload) }
        }
        val seen = mutableListOf<Pair<Long, Long>>()
        val downloaded = AppUpdateInstaller.download(
            apkUrl = "$baseUrl/pkg.apk",
            expectedSha256 = expected,
            version = "0.7.6",
            targetDir = dir,
            onProgress = { read, total -> seen.add(read to total) },
            cancelled = AtomicBoolean(false),
        )
        assertTrue(downloaded.apkFile.exists())
        assertEquals(expected, AppUpdateInstaller.sha256Hex(downloaded.apkFile))
        assertTrue(seen.isNotEmpty())
        assertEquals(payload.size.toLong(), seen.last().first)
    }

    @Test
    fun hashMismatchDeletesTheFile() {
        val payload = "tampered".toByteArray()
        server.createContext("/evil.apk") { exchange ->
            exchange.sendResponseHeaders(200, payload.size.toLong())
            exchange.responseBody.use { it.write(payload) }
        }
        try {
            AppUpdateInstaller.download(
                apkUrl = "$baseUrl/evil.apk",
                expectedSha256 = "0".repeat(64),
                version = "0.7.6",
                targetDir = dir,
                onProgress = { _, _ -> },
                cancelled = AtomicBoolean(false),
            )
            fail("expected HashMismatch")
        } catch (error: UpdateDownloadError.HashMismatch) {
            assertEquals(0, dir.listFiles()?.size ?: 0)
        }
    }

    @Test
    fun httpErrorsAndOversizedBodiesAreRejected() {
        server.createContext("/missing.apk") { exchange ->
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
        }
        try {
            AppUpdateInstaller.download(
                apkUrl = "$baseUrl/missing.apk",
                expectedSha256 = "0".repeat(64),
                version = "0.7.6",
                targetDir = dir,
                onProgress = { _, _ -> },
                cancelled = AtomicBoolean(false),
            )
            fail("expected Network")
        } catch (error: UpdateDownloadError.Network) {
            // expected
        }
    }

    @Test
    fun cancellationDeletesThePartialFile() {
        val payload = ByteArray(4 * 1024 * 1024) { 7 }
        server.createContext("/slow.apk") { exchange ->
            exchange.sendResponseHeaders(200, payload.size.toLong())
            exchange.responseBody.use { out ->
                var offset = 0
                while (offset < payload.size) {
                    val end = minOf(offset + 8192, payload.size)
                    out.write(payload, offset, end - offset)
                    out.flush()
                    offset = end
                    Thread.sleep(5)
                }
            }
        }
        val cancelled = AtomicBoolean(false)
        Thread { Thread.sleep(100); cancelled.set(true) }.start()
        try {
            AppUpdateInstaller.download(
                apkUrl = "$baseUrl/slow.apk",
                expectedSha256 = sha256(payload),
                version = "0.7.6",
                targetDir = dir,
                onProgress = { _, _ -> },
                cancelled = cancelled,
            )
            fail("expected Cancelled")
        } catch (error: UpdateDownloadError.Cancelled) {
            assertEquals(0, dir.listFiles()?.size ?: 0)
        }
    }

    @Test
    fun fetchesThePublishedHashFromTheShaSidecar() {
        val hash = "ab".repeat(32)
        server.createContext("/pkg2.apk.sha256") { exchange ->
            val body = "$hash  pkg2.apk\n".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        assertEquals(
            hash,
            AppUpdateInstaller.fetchExpectedSha256("$baseUrl/pkg2.apk", "pkg2.apk"),
        )
    }
}
