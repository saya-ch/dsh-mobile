package io.github.sayach.dshmobile

import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.RenderProcessGoneDetail
import java.io.ByteArrayInputStream
import java.security.cert.X509Certificate

/** A matching secure authority alone cannot authorize an untrusted certificate callback. */
internal fun acceptsPinnedWebViewSslError(
    origin: GatewayOrigin,
    caCertificate: ByteArray?,
    primaryError: Int,
    url: String,
    leaf: X509Certificate?,
): Boolean = caCertificate != null && primaryError == SslError.SSL_UNTRUSTED
    && GatewayUrlPolicy.isPinnedAuthority(origin, url)
    && PinnedTls.acceptsWebViewLeaf(origin, caCertificate, leaf)

/** Categories of main-frame failures that need a native recovery surface. */
internal enum class LoadFailure {
    TLS,
    NETWORK,
    AUTH_EXPIRED,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
}

internal fun loadFailureForHttpStatus(status: Int): LoadFailure = when (status) {
    401, 403 -> LoadFailure.AUTH_EXPIRED
    429 -> LoadFailure.RATE_LIMITED
    in 500..599 -> LoadFailure.SERVICE_UNAVAILABLE
    else -> LoadFailure.NETWORK
}

/** First-boot failures require explicit retry rather than repeatedly replacing an unfinished page. */
internal fun shouldAutomaticallyRecoverPage(failure: LoadFailure, initialLoadPending: Boolean): Boolean =
    !initialLoadPending && failure in setOf(LoadFailure.NETWORK, LoadFailure.AUTH_EXPIRED, LoadFailure.SERVICE_UNAVAILABLE)

/** Whether a remote load failure should direct the user to refresh a temporary cpolar address. */
internal fun isCpolarAddressFailure(
    failure: LoadFailure,
    mode: AccessMode,
    origin: GatewayOrigin?,
): Boolean = failure == LoadFailure.NETWORK && mode == AccessMode.REMOTE
    && origin?.host?.let(RemoteHostPolicy::isCpolarHost) == true

/** Main-frame budget after native authentication has already completed. */
internal fun webViewLoadTimeoutMs(host: String): Long = when {
    RemoteHostPolicy.isCpolarHost(host) -> 120_000L
    RemoteHostPolicy.isRemoteCandidate(host) -> 30_000L
    IrohDeviceBinding.isIrohHost(host) -> 30_000L
    else -> 15_000L
}

/** Subframes may load only resources and documents from the authenticated gateway. */
internal fun shouldBlockSubframeNavigation(origin: GatewayOrigin, candidate: String): Boolean =
    !GatewayUrlPolicy.isSameOrigin(origin, candidate)

/** Enforces exact-origin navigation and optionally accepts the LAN pairing CA. */
internal class SecureWebViewClient(
    private val origin: GatewayOrigin,
    private val caCertificate: ByteArray?,
    private val openExternal: (Uri) -> Unit,
    private val onBlocked: () -> Unit,
    private val onFailure: (LoadFailure) -> Unit,
    private val onRendererGone: () -> Unit,
    private val onTopLevelUrlChanged: (String) -> Unit,
    private val onLoaded: () -> Unit,
    private val onBeforeTopLevelNavigation: () -> Unit,
    private val onContentVisible: (documentGeneration: Int) -> Unit = {},
    private val connectionDeadlineActive: () -> Boolean = { false },
    private val bootAssets: BootAssetResponder? = null,
) : WebViewClient() {
    private val handler = Handler(Looper.getMainLooper())
    private val document = WebViewDocumentState(origin)
    private var timeout: Runnable? = null
    private var loadingUrl: String? = null

    val currentDocumentGeneration: Int get() = document.generation

    /** Release the transport timer only after this document's real DOM was found usable. */
    fun confirmContentReady(expectedGeneration: Int): Boolean {
        if (!document.confirmContentReady(expectedGeneration)) return false
        clearTimeout()
        return true
    }

    fun dispose() {
        clearTimeout()
        // A destroyed page must not keep a download, its socket or its `.part` file alive.
        bootAssets?.cancelInFlight()
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val candidate = request.url.toString()
        if (!request.isForMainFrame) return shouldBlockSubframeNavigation(origin, candidate)
        if (GatewayUrlPolicy.isSameOrigin(origin, candidate)) {
            val currentUrl = view.url.orEmpty()
            val fragmentOnly = sameMainDocumentUrl(origin, currentUrl, candidate) &&
                Uri.parse(currentUrl).encodedFragment != request.url.encodedFragment
            if (!fragmentOnly) onBeforeTopLevelNavigation()
            return false
        }
        if (request.hasGesture() && GatewayUrlPolicy.isExternalHttps(candidate)) {
            openExternal(request.url)
        } else {
            onBlocked()
        }
        return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        document.started()
        // The previous document's boot batches are moot; stop any download it still owns.
        bootAssets?.cancelInFlight()
        onTopLevelUrlChanged(url)
        if (url != "about:blank" && !GatewayUrlPolicy.isSameOrigin(origin, url)) {
            clearTimeout()
            view.stopLoading()
            onBlocked()
            return
        }
        if (GatewayUrlPolicy.isSameOrigin(origin, url)) armTimeout(view, url)
    }

    override fun onPageFinished(view: WebView, url: String) {
        val currentUrl = view.url ?: url
        if (sameMainDocumentUrl(origin, currentUrl, url)) {
            clearTimeout()
            if (document.finished(url, currentUrl)) onLoaded()
        }
    }

    override fun onPageCommitVisible(view: WebView, url: String) {
        if (document.canInspectContent(url, view.url ?: url)) {
            onContentVisible(document.generation)
        }
    }

    /**
     * Answers only revisioned boot batches that [BootAssetResponder] revalidated for this session.
     * Everything else returns null so the WebView's own navigation, TLS, cookie and error paths
     * remain authoritative; a cache miss is never a new failure mode. Chromium calls this on a
     * background thread, and the responder's bounded worker owns the download so it can be cancelled
     * from [dispose] or the next [onPageStarted].
     */
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val served = bootAssets?.response(request.method, request.isForMainFrame, request.url.toString()) ?: return null
        // Building the response can still throw (a header value or stream the current WebView
        // implementation rejects); a throw here would abort the subresource instead of loading it.
        return runCatching {
            WebResourceResponse(served.contentType, "utf-8", ByteArrayInputStream(served.body)).apply {
                setResponseHeaders(
                    buildMap {
                        put("Content-Type", "${served.contentType}; charset=utf-8")
                        put("Content-Length", served.body.size.toString())
                        put("Cache-Control", "private, max-age=30, must-revalidate")
                        served.etag?.let { put("ETag", it) }
                    },
                )
            }
        }.getOrNull()
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        // A WebSocket handshake reaches this callback with a `wss:` URL, so an exact `https:`
        // origin check rejects the page's own stream channel and cancels the document it belongs
        // to. Host and port must still match exactly, and the leaf must pin.
        val pinned = acceptsPinnedWebViewSslError(origin, caCertificate, error.primaryError,
            error.url, error.certificate.x509Certificate)
        if (pinned) {
            handler.proceed()
        } else {
            document.failed()
            clearTimeout()
            handler.cancel()
            view.stopLoading()
            onFailure(LoadFailure.TLS)
        }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) {
            document.failed()
            clearTimeout()
            onFailure(LoadFailure.NETWORK)
        }
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse,
    ) {
        if (request.isForMainFrame && errorResponse.statusCode >= 400) {
            document.failed()
            clearTimeout()
            onFailure(loadFailureForHttpStatus(errorResponse.statusCode))
        }
    }

    override fun onSafeBrowsingHit(
        view: WebView,
        request: WebResourceRequest,
        threatType: Int,
        callback: SafeBrowsingResponse,
    ) {
        callback.backToSafety(true)
        if (request.isForMainFrame) {
            document.failed()
            clearTimeout()
            onFailure(LoadFailure.NETWORK)
        }
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        document.failed()
        clearTimeout()
        onRendererGone()
        return true
    }

    private fun armTimeout(view: WebView, url: String) {
        clearTimeout()
        loadingUrl = url
        val expectedGeneration = document.generation
        val task = Runnable {
            if (loadingUrl != url || !document.shouldTimeout(expectedGeneration, connectionDeadlineActive())) return@Runnable
            loadingUrl = null
            timeout = null
            document.failed()
            view.stopLoading()
            onFailure(LoadFailure.NETWORK)
        }
        timeout = task
        handler.postDelayed(task, webViewLoadTimeoutMs(origin.host))
    }

    private fun clearTimeout() {
        timeout?.let(handler::removeCallbacks)
        timeout = null
        loadingUrl = null
    }
}
