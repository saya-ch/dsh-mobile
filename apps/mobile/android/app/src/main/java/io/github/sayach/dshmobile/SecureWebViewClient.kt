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

/** Whether a remote load failure should direct the user to refresh a temporary cpolar address. */
internal fun isCpolarAddressFailure(
    failure: LoadFailure,
    mode: AccessMode,
    origin: GatewayOrigin?,
): Boolean = failure == LoadFailure.NETWORK && mode == AccessMode.REMOTE
    && origin?.host?.let(RemoteHostPolicy::isCpolarHost) == true

/** Main-frame budget after native authentication has already completed. */
internal fun webViewLoadTimeoutMs(host: String): Long =
    if (RemoteHostPolicy.isRemoteCandidate(host)) 30_000L else 15_000L

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
    private val onTopLevelUrlChanged: (String) -> Unit,
    private val onLoaded: () -> Unit,
) : WebViewClient() {
    private val handler = Handler(Looper.getMainLooper())
    private var timeout: Runnable? = null
    private var loadingUrl: String? = null

    fun dispose() {
        clearTimeout()
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val candidate = request.url.toString()
        if (!request.isForMainFrame) return shouldBlockSubframeNavigation(origin, candidate)
        if (GatewayUrlPolicy.isSameOrigin(origin, candidate)) return false
        if (request.hasGesture() && GatewayUrlPolicy.isExternalHttps(candidate)) {
            openExternal(request.url)
        } else {
            onBlocked()
        }
        return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
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
        if (GatewayUrlPolicy.isSameOrigin(origin, url)) {
            if (loadingUrl == url) clearTimeout()
            onLoaded()
        }
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        val pinned = caCertificate != null && error.primaryError == SslError.SSL_UNTRUSTED
            && GatewayUrlPolicy.isSameOrigin(origin, error.url)
            && PinnedTls.acceptsWebViewLeaf(origin, caCertificate, error.certificate.x509Certificate)
        if (pinned) {
            handler.proceed()
        } else {
            clearTimeout()
            handler.cancel()
            view.stopLoading()
            onFailure(LoadFailure.TLS)
        }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) {
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
        clearTimeout()
        callback.backToSafety(true)
        onFailure(LoadFailure.NETWORK)
    }

    private fun armTimeout(view: WebView, url: String) {
        clearTimeout()
        loadingUrl = url
        val task = Runnable {
            if (loadingUrl != url) return@Runnable
            loadingUrl = null
            timeout = null
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
