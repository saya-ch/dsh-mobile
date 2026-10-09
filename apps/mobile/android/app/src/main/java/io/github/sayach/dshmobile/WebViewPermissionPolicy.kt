package io.github.sayach.dshmobile

import android.webkit.PermissionRequest

/**
 * Decides which WebView permission requests the paired GUI page may satisfy.
 *
 * DSH's voice-input plugin records through `getUserMedia`, which Chromium routes
 * to `WebChromeClient.onPermissionRequest`. Only the microphone of the trusted
 * gateway origin is granted; other origins and resources stay denied.
 * Android PermissionRequest does not identify whether its frame is top-level.
 */
internal object WebViewPermissionPolicy {
    /**
     * @param resources resources the requesting frame asked for.
     * @param requestOrigin origin reported by the WebView, or null when it has none.
     * @param trustedOrigin origin this install is paired with.
     * @return whether microphone capture may be granted for this request.
     */
    fun shouldGrantAudioCapture(
        resources: List<String>,
        requestOrigin: String?,
        trustedOrigin: GatewayOrigin,
    ): Boolean = resources == listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
        GatewayOrigin.parse(requestOrigin ?: "") == trustedOrigin
}
