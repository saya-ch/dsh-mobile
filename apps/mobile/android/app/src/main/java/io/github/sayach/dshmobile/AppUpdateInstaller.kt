package io.github.sayach.dshmobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/** Where the verified update APK lives before the package installer reads it. */
internal data class UpdateDownload(val apkFile: File, val version: String)

/** Terminal download failures, surfaced to the user with a retry or browser fallback. */
internal sealed class UpdateDownloadError(message: String) : IOException(message) {
    /** Any transport failure: DNS, TLS, HTTP status, timeout, truncated body. */
    class Network(message: String) : UpdateDownloadError(message)

    /** The server advertises, or actually sends, more than the cap. */
    class TooLarge(val limitBytes: Long) : UpdateDownloadError("apk_too_large")

    /** Bytes downloaded fine but the SHA-256 does not match the published file. */
    class HashMismatch(val fileName: String) : UpdateDownloadError("apk_hash_mismatch")

    /** The user cancelled from the progress dialog; the partial file is deleted. */
    class Cancelled : UpdateDownloadError("apk_download_cancelled")
}

/**
 * Downloads a published update APK and hands it to the platform package installer.
 *
 * The APK and its `.sha256` sidecar are the exact assets the release workflow uploads
 * (`for apk in dsh-mobile-android-v*.apk; do sha256sum "$apk" > "$apk.sha256"; done`), so
 * both URLs are derived from the release descriptor without changing `release.json`:
 * `.../releases/download/<tag>/<asset>` and `<that>.sha256`. Nothing installs unless the
 * streamed bytes hash to the published value; a mismatch deletes the file.
 *
 * The full (`-iroh`) build and the compatibility build stay on their own lane: a phone
 * running the native iroh transport downloads the full APK, anything else the compat one,
 * so an update can never replace a 64-bit-only install with a build that drops an ABI.
 */
internal object AppUpdateInstaller {
    const val RELEASE_DOWNLOAD_BASE = "https://github.com/saya-ch/dsh-mobile/releases/download/"
    const val MAX_APK_BYTES = 200L * 1024 * 1024
    const val UPDATE_SUBDIR = "updates"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 15_000

    /** Exact asset name the release workflow uploads for one version. */
    fun apkAssetName(version: String, irohFull: Boolean): String =
        "dsh-mobile-android-v$version${if (irohFull) "-iroh" else ""}.apk"

    fun apkUrl(releaseTag: String, assetName: String): String =
        "$RELEASE_DOWNLOAD_BASE$releaseTag/$assetName"

    fun shaUrl(apkUrl: String): String = "$apkUrl.sha256"

    /**
     * Parses one `sha256sum` line ("`<hex>  <file>`", also accepts the `*` binary marker
     * and CRLF). Returns null unless the line names exactly [expectedFileName].
     */
    fun parseSha256File(text: String, expectedFileName: String): String? {
        val line = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return null
        val parts = line.split(Regex("\\s+"), limit = 2)
        if (parts.size != 2) return null
        val (hash, name) = parts
        if (name.trimStart('*') != expectedFileName) return null
        if (!hash.matches(Regex("[0-9a-fA-F]{64}"))) return null
        return hash.lowercase()
    }

    fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(32 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Streams [apkUrl] to the app cache, enforces the size cap while reading, reports
     * progress as (bytesRead, totalOrMinusOne), then verifies the SHA-256 fetched from
     * [shaUrl]. Any failure — including [cancelled] — deletes the partial file.
     */
    @Throws(UpdateDownloadError::class)
    fun download(
        apkUrl: String,
        expectedSha256: String,
        version: String,
        targetDir: File,
        onProgress: (bytesRead: Long, totalBytes: Long) -> Unit,
        cancelled: AtomicBoolean,
    ): UpdateDownload {
        val assetName = apkUrl.substringAfterLast('/')
        if (targetDir.mkdirs().not() && !targetDir.isDirectory) throw UpdateDownloadError.Network("apk_cache_unwritable")
        val tmp = File.createTempFile("update-", ".apk", targetDir)
        try {
            val connection = URL(apkUrl).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = CONNECT_TIMEOUT_MS
                connection.readTimeout = READ_TIMEOUT_MS
                connection.instanceFollowRedirects = true
                connection.requestMethod = "GET"
                connection.setRequestProperty("Accept", "application/vnd.android.package-archive")
                connection.setRequestProperty("User-Agent", "dsh-mobile-android")
                val status = connection.responseCode
                if (status != HttpURLConnection.HTTP_OK) throw UpdateDownloadError.Network("apk_http_$status")
                val advertised = connection.contentLengthLong
                if (advertised > MAX_APK_BYTES) throw UpdateDownloadError.TooLarge(MAX_APK_BYTES)
                val total = if (advertised >= 0) advertised else -1L
                var read = 0L
                onProgress(0L, total)
                connection.inputStream.use { input ->
                    FileOutputStream(tmp).use { output ->
                        val buffer = ByteArray(32 * 1024)
                        while (true) {
                            if (cancelled.get()) throw UpdateDownloadError.Cancelled()
                            val count = input.read(buffer)
                            if (count < 0) break
                            read += count
                            if (read > MAX_APK_BYTES) throw UpdateDownloadError.TooLarge(MAX_APK_BYTES)
                            output.write(buffer, 0, count)
                            onProgress(read, total)
                        }
                    }
                }
            } finally {
                connection.disconnect()
            }
            val actual = sha256Hex(tmp)
            if (!actual.equals(expectedSha256, ignoreCase = true)) throw UpdateDownloadError.HashMismatch(assetName)
            val final = File(targetDir, assetName)
            if (final.exists() && !final.delete()) throw UpdateDownloadError.Network("apk_replace_failed")
            if (!tmp.renameTo(final)) throw UpdateDownloadError.Network("apk_finalize_failed")
            return UpdateDownload(final, version)
        } catch (error: UpdateDownloadError) {
            tmp.delete()
            throw error
        } catch (error: IOException) {
            tmp.delete()
            throw UpdateDownloadError.Network("apk_io_${error.message}")
        }
    }

    /** Fetches the published `.sha256` sidecar and extracts the hash for [assetName]. */
    @Throws(UpdateDownloadError::class)
    fun fetchExpectedSha256(apkUrl: String, assetName: String): String {
        val connection = URL(shaUrl(apkUrl)).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = true
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "text/plain")
            connection.setRequestProperty("User-Agent", "dsh-mobile-android")
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw UpdateDownloadError.Network("sha_http_${connection.responseCode}")
            }
            val text = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            return parseSha256File(text, assetName) ?: throw UpdateDownloadError.Network("sha_unparseable")
        } catch (error: UpdateDownloadError) {
            throw error
        } catch (error: IOException) {
            throw UpdateDownloadError.Network("sha_io_${error.message}")
        } finally {
            connection.disconnect()
        }
    }

    /** Package-installer intent for a verified APK shared through the app FileProvider. */
    fun installIntent(context: Context, apkFile: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apkFile)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /** API 26+ needs the user-visible unknown-sources grant; below that it installs directly. */
    fun canInstallUnknownApps(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    /** System screen that grants this app the unknown-sources install permission. */
    fun unknownSourcesIntent(context: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
}
