package io.github.sayach.dshmobile

import android.webkit.CookieManager
import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.util.zip.GZIPInputStream
import javax.net.ssl.HttpsURLConnection

/** Connect budget for one boot batch; page navigation keeps its own, larger, budget. */
internal const val BOOT_ASSET_CONNECT_TIMEOUT_MS = 3_000

/** Read budget for one boot batch; a stalled body must not hold the request thread. */
internal const val BOOT_ASSET_READ_TIMEOUT_MS = 4_000

/**
 * Hard ceiling for one interception: the Chromium request thread is blocked while it waits.
 *
 * Six seconds is about twice a healthy LAN batch fetch and stays above the connect budget, so a
 * reachable gateway is never cut off mid-handshake. Past that point a cache miss is cheaper than a
 * slow page: the wait is cancelled, the socket is disconnected, and `shouldInterceptRequest` returns
 * null so the WebView performs its own request with its own, larger, budget. The cost of being wrong
 * is therefore one duplicated request, never a failed load.
 */
internal const val BOOT_ASSET_INTERCEPT_DEADLINE_MS = 6_000L

/**
 * Fetches one revisioned boot batch over the same pinned transport the shell already uses.
 *
 * Requests carry the WebView's own session cookie, so a cached body is only ever served after the
 * gateway answered the current request (304). Responses without a validator are served but not
 * stored; 401/403 and any transport failure are reported as [BootAssetFetch.Rejected] or
 * [BootAssetFetch.Failed] and fall through to the WebView's normal path.
 *
 * Body consistency: the transferred byte count must match the declared `Content-Length` and the
 * decoded body is hashed, so a truncated, padded or re-encoded response is refused instead of being
 * stored. Cancellation disconnects the connection because a blocking socket read cannot observe a
 * thread interrupt; the attempt then reports [BootAssetFetch.Cancelled] and stores nothing.
 */
internal class HttpBootAssetFetcher(
    private val origin: GatewayOrigin,
    private val transport: TransportEndpoint = LocalTransport,
    private val caCertificate: ByteArray?,
    private val userAgent: String?,
    private val cookieProvider: (String) -> String? = { url -> CookieManager.getInstance().getCookie(url) },
    private val connectTimeoutMs: Int = BOOT_ASSET_CONNECT_TIMEOUT_MS,
    private val readTimeoutMs: Int = BOOT_ASSET_READ_TIMEOUT_MS,
) : BootAssetFetcher {
    override fun fetch(url: String, etag: String?, cancellation: BootAssetCancellation): BootAssetFetch {
        if (cancellation.isCancelled) return BootAssetFetch.Cancelled
        if (BootAssetPolicy.key(origin, url) == null) return BootAssetFetch.Failed
        // A plugin combo carries its module list and revision in the query, so the request path is
        // `rawPath` plus `?rawQuery`. A boot batch has no query and keeps the bare path.
        val parsed = runCatching { URI(url) }.getOrNull() ?: return BootAssetFetch.Failed
        val path = buildString {
            append(parsed.rawPath ?: return BootAssetFetch.Failed)
            val query = parsed.rawQuery
            if (!query.isNullOrEmpty()) append('?').append(query)
        }
        val connection = runCatching { transport.open(origin, path) }.getOrNull()
            ?: return BootAssetFetch.Failed
        cancellation.onCancel { runCatching { connection.disconnect() } }
        return try {
            if (caCertificate != null) connection.sslSocketFactory = PinnedTls.socketFactory(caCertificate)
            connection.instanceFollowRedirects = false
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept-Encoding", "gzip")
            if (!userAgent.isNullOrBlank()) connection.setRequestProperty("User-Agent", userAgent)
            if (!etag.isNullOrBlank()) connection.setRequestProperty("If-None-Match", etag)
            cookieProvider(url)?.takeIf { it.isNotBlank() }?.let { cookie ->
                connection.setRequestProperty("Cookie", cookie)
            }
            when (connection.responseCode) {
                HTTP_NOT_MODIFIED -> BootAssetFetch.NotModified
                HTTP_OK -> readResponse(connection, cancellation)
                HTTP_UNAUTHORIZED, HTTP_FORBIDDEN -> BootAssetFetch.Rejected
                else -> BootAssetFetch.Failed
            }
        } catch (_: IOException) {
            if (cancellation.isCancelled) BootAssetFetch.Cancelled else BootAssetFetch.Failed
        } catch (_: RuntimeException) {
            if (cancellation.isCancelled) BootAssetFetch.Cancelled else BootAssetFetch.Failed
        } finally {
            // A completed response returns its socket to the connection pool, so the next batch can
            // reuse the same TCP + TLS session. Calling `disconnect()` unconditionally threw that
            // away and re-handshaked for every batch; only a cancelled attempt needs the explicit
            // disconnect, because that is what unblocks a socket read.
            if (cancellation.isCancelled) runCatching { connection.disconnect() }
        }
    }

    private fun readResponse(connection: HttpsURLConnection, cancellation: BootAssetCancellation): BootAssetFetch {
        val declared = connection.contentLengthLong
        if (declared > MAX_BOOT_ASSET_BYTES) return BootAssetFetch.Failed
        val encoding = connection.contentEncoding?.trim()?.lowercase()
        if (encoding != null && encoding != "gzip" && encoding != "identity") return BootAssetFetch.Failed
        val received = CountingInputStream(connection.inputStream)
        val body = runCatching {
            val stream: InputStream = if (encoding == "gzip") GZIPInputStream(received) else received
            stream.use { readAtMost(it, cancellation) }
        }.getOrNull()
        if (cancellation.isCancelled) return BootAssetFetch.Cancelled
        if (body == null) return BootAssetFetch.Failed
        // A transfer that ends before its declared length was truncated on the wire; never store it.
        if (declared >= 0L && received.count != declared) return BootAssetFetch.Failed
        val contentType = connection.contentType
            ?.substringBefore(';')
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: DEFAULT_CONTENT_TYPE
        return BootAssetFetch.Modified(
            etag = connection.getHeaderField("ETag"),
            contentType = contentType,
            body = body,
            digest = BootAssetDigest.of(body),
            // The counted bytes are the compressed transfer, measured before GZIPInputStream.
            wireBytes = received.count,
        )
    }

    /** Reads a body but refuses to allocate past [MAX_BOOT_ASSET_BYTES] and stops when cancelled. */
    private fun readAtMost(input: InputStream, cancellation: BootAssetCancellation): ByteArray? {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            if (cancellation.isCancelled) return null
            val read = input.read(buffer)
            if (read < 0) return output.toByteArray()
            total += read
            if (total > MAX_BOOT_ASSET_BYTES) return null
            output.write(buffer, 0, read)
        }
    }

    /** Counts the bytes actually read off the wire so `Content-Length` can be enforced. */
    private class CountingInputStream(input: InputStream) : FilterInputStream(input) {
        var count: Long = 0L
            private set

        override fun read(): Int {
            val value = `in`.read()
            if (value >= 0) count += 1
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            val read = `in`.read(buffer, offset, length)
            if (read > 0) count += read
            return read
        }
    }

    private companion object {
        const val HTTP_OK = 200
        const val HTTP_NOT_MODIFIED = 304
        const val HTTP_UNAUTHORIZED = 401
        const val HTTP_FORBIDDEN = 403
        const val DEFAULT_CONTENT_TYPE = "text/javascript"
    }
}
