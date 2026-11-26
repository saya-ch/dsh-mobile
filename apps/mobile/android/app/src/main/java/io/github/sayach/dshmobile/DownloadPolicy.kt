package io.github.sayach.dshmobile

import androidx.webkit.URLUtilCompat
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.net.URLDecoder
import java.util.Locale

private const val BINARY_DOWNLOAD_MIME_TYPE = "application/octet-stream"
private val DOWNLOAD_MIME_TYPE = Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+*-]+$")

/** Reads RFC 6266 filenames independently of the Android system's URLUtil version. */
internal fun downloadFilenameFromContentDisposition(contentDisposition: String?): String? {
    val disposition = contentDisposition?.trim() ?: return null
    // An unsupported inline preview can reach DownloadListener too. At this point the
    // user is saving the response, so retain its filename rather than rejecting inline.
    val parameters = disposition.indexOf(';')
    val downloadDisposition = if (parameters >= 0 && disposition.substring(0, parameters).trim().equals("inline", true)) {
        "attachment" + disposition.substring(parameters)
    } else disposition
    return URLUtilCompat.getFilenameFromContentDisposition(downloadDisposition)?.takeIf { it.isNotBlank() }
}

/** Resolves a download name after the caller has checked the URL's exact Origin. */
internal fun downloadFilename(url: String, contentDisposition: String?): String {
    return downloadFilenameFromContentDisposition(contentDisposition)
        ?: workspaceDownloadFilename(url)
        ?: URLUtilCompat.guessFileName(url, null, null)
}

/** DSH's HTTP file URL carries the real name in `path`, while its URL basename is just `file`. */
internal fun workspaceDownloadFilename(url: String): String? = runCatching {
    val uri = URI(url)
    if (uri.rawPath != "/api/file") return null
    val pathParameter = uri.rawQuery?.split('&')?.firstOrNull { it.substringBefore('=') == "path" }
        ?: return null
    val path = URLDecoder.decode(pathParameter.substringAfter('=', ""), "UTF-8")
    path.replace('\\', '/').substringAfterLast('/').takeIf { it.isNotBlank() && it != "." && it != ".." }
}.getOrNull()

/** A generic response type must not make the document picker replace an APK's extension. */
internal fun downloadMimeType(
    filename: String,
    reportedMimeType: String?,
    mimeTypeFromExtension: (String) -> String?,
): String {
    fun normalized(value: String?): String? = value?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
        ?.takeIf { DOWNLOAD_MIME_TYPE.matches(it) }

    val reported = normalized(reportedMimeType) ?: BINARY_DOWNLOAD_MIME_TYPE
    if (reported != BINARY_DOWNLOAD_MIME_TYPE) return reported
    val extension = filename.substringAfterLast('.', "").lowercase(Locale.ROOT)
    return normalized(mimeTypeFromExtension(extension)) ?: reported
}

internal const val MAX_DOWNLOAD_BYTES = 256L * 1024 * 1024
internal const val STALE_DOWNLOAD_AGE_MS = 24L * 60 * 60 * 1000
private const val DOWNLOAD_PREFIX = "dsh-download-"
private const val DOWNLOAD_SUFFIX = ".tmp"

/** Copies a download without allowing the response to exceed the mobile storage budget. */
internal fun copyDownloadAtMost(
    input: InputStream,
    output: OutputStream,
    maxBytes: Long = MAX_DOWNLOAD_BYTES,
): Long {
    require(maxBytes >= 0) { "maxBytes must not be negative" }
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var copied = 0L
    while (true) {
        val count = input.read(buffer)
        if (count < 0) return copied
        if (count == 0) {
            val next = input.read()
            if (next < 0) return copied
            if (copied >= maxBytes) throw IOException("Download exceeds the mobile size limit")
            output.write(next)
            copied += 1
            continue
        }
        if (copied > maxBytes - count) throw IOException("Download exceeds the mobile size limit")
        output.write(buffer, 0, count)
        copied += count
    }
}

/** Removes abandoned download staging files after they can no longer belong to a live Activity. */
internal fun cleanupStaleDownloadFiles(
    cacheDirectory: File,
    now: Long = System.currentTimeMillis(),
    staleAgeMs: Long = STALE_DOWNLOAD_AGE_MS,
) {
    if (staleAgeMs < 0) return
    val staleBefore = now - staleAgeMs
    cacheDirectory.listFiles()?.forEach { file ->
        if (file.isFile
            && file.name.startsWith(DOWNLOAD_PREFIX)
            && file.name.endsWith(DOWNLOAD_SUFFIX)
            && file.lastModified() <= staleBefore) {
            file.delete()
        }
    }
}
