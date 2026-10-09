package io.github.sayach.dshmobile

import android.webkit.WebView
import org.json.JSONObject
import kotlin.math.roundToInt

/** User-selected base page scale, independent from DSH content font size. */
internal object NativeDisplayScalePolicy {
    const val MIN_PERCENT = 80
    const val MAX_PERCENT = 125
    const val DEFAULT_PERCENT = 100

    fun isValid(percent: Double): Boolean = percent.isFinite() && percent % 1.0 == 0.0 &&
        percent >= MIN_PERCENT && percent <= MAX_PERCENT

    fun storedPercent(percent: Int): Int = percent.takeIf { it in MIN_PERCENT..MAX_PERCENT } ?: DEFAULT_PERCENT

    /** Fits the CSS viewport to the native safe width at the requested base scale. */
    fun viewportWidth(nativeWidth: Int, density: Float, percent: Int): Int {
        require(nativeWidth > 0 && density.isFinite() && density > 0f)
        require(percent in MIN_PERCENT..MAX_PERCENT)
        return (nativeWidth / density / (percent / 100f)).roundToInt().coerceIn(1, 10_000)
    }
}

/** Changes the paired document's viewport without replacing its DOM or WebView. */
internal class NativeDisplayScale(
    private val browser: WebView,
    private val origin: GatewayOrigin,
    storedPercent: Int,
) {
    var percent = NativeDisplayScalePolicy.storedPercent(storedPercent)
        private set
    private var documentReady = false
    private var appliedWidth = -1
    private var appliedPercent = -1

    fun onDocumentStarted() {
        documentReady = false
        appliedWidth = -1
    }

    fun onDocumentReady() {
        documentReady = true
        apply()
    }

    fun set(percent: Int) {
        require(percent in NativeDisplayScalePolicy.MIN_PERCENT..NativeDisplayScalePolicy.MAX_PERCENT)
        this.percent = percent
        apply()
    }

    /** Keyboard height changes keep the same scale; only a new width needs viewport reflow. */
    fun apply() {
        if (!documentReady || browser.width <= 0 || !GatewayUrlPolicy.isSameOrigin(origin, browser.url.orEmpty())) return
        val width = NativeDisplayScalePolicy.viewportWidth(browser.width, browser.resources.displayMetrics.density, percent)
        if (appliedWidth == width && appliedPercent == percent) return
        val script = """
            (function () {
              if (window.top !== window || location.origin !== ${JSONObject.quote(origin.serialized)} || !document.head) return;
              var viewport = document.querySelector('meta[name="viewport"]');
              if (!viewport) { viewport = document.createElement('meta'); viewport.name = 'viewport'; document.head.appendChild(viewport); }
              var extra = (viewport.getAttribute('content') || '').split(',').filter(function (entry) {
                return !/^\s*(?:width|initial-scale)\s*=/i.test(entry);
              }).filter(function (entry) { return entry.trim() !== ''; });
              var content = ['width=$width', 'initial-scale=${percent / 100.0}'].concat(extra).join(',');
              if (viewport.getAttribute('content') !== content) viewport.setAttribute('content', content);
            })();
        """.trimIndent()
        browser.evaluateJavascript(script, null)
        appliedWidth = width
        appliedPercent = percent
    }
}
