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

    /** Smallest initial scale Chromium honours; a smaller one is clamped and would overflow. */
    const val MIN_INITIAL_SCALE = 0.25

    /**
     * A floating window shows a shrunken copy of the page, not a narrow phone. Refitting the
     * viewport to the window would reflow the layout, and any widget with a fixed size would
     * then keep its pixel size and fill the window instead of holding its corner. So the
     * full-screen layout width is kept and the whole page is scaled down to the window.
     *
     * Below [MIN_INITIAL_SCALE] the layout would overflow the window, so in that case the width
     * is narrowed to what still fits at that scale.
     *
     * @return CSS layout width and the initial scale that fits it into the window.
     */
    fun pictureInPictureViewport(
        fullScreenWidthPx: Int,
        windowWidthPx: Int,
        density: Float,
        percent: Int,
    ): Pair<Int, Double> {
        require(fullScreenWidthPx > 0 && windowWidthPx > 0 && density.isFinite() && density > 0f)
        require(percent in MIN_PERCENT..MAX_PERCENT)
        val fullCssWidth = viewportWidth(fullScreenWidthPx, density, percent)
        val rawScale = windowWidthPx.toDouble() / (fullCssWidth * density)
        if (rawScale >= MIN_INITIAL_SCALE) return fullCssWidth to rawScale
        val narrowed = (windowWidthPx / (density * MIN_INITIAL_SCALE)).roundToInt().coerceIn(1, 10_000)
        return narrowed to MIN_INITIAL_SCALE
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
    private var appliedScale = -1.0
    private var floating = false
    private var fullScreenWidthPx = -1

    fun onDocumentStarted() {
        documentReady = false
        appliedWidth = -1
    }

    /** Floats the current page into picture-in-picture, or restores it when the window closes. */
    fun setFloating(active: Boolean) {
        if (floating == active) return
        floating = active
        apply()
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
        val density = browser.resources.displayMetrics.density
        val scale: Double
        val width: Int
        if (floating && fullScreenWidthPx > 0) {
            val fit = NativeDisplayScalePolicy.pictureInPictureViewport(
                fullScreenWidthPx, browser.width, density, percent,
            )
            width = fit.first
            scale = fit.second
        } else {
            // Remember the full-screen width: the floating window has to shrink from it rather
            // than fit itself, and once floating starts browser.width is the window, not the page.
            fullScreenWidthPx = browser.width
            width = NativeDisplayScalePolicy.viewportWidth(browser.width, density, percent)
            scale = percent / 100.0
        }
        if (appliedWidth == width && appliedPercent == percent && appliedScale == scale) return
        val script = """
            (function () {
              if (window.top !== window || location.origin !== ${JSONObject.quote(origin.serialized)} || !document.head) return;
              var viewport = document.querySelector('meta[name="viewport"]');
              if (!viewport) { viewport = document.createElement('meta'); viewport.name = 'viewport'; document.head.appendChild(viewport); }
              var extra = (viewport.getAttribute('content') || '').split(',').filter(function (entry) {
                return !/^\s*(?:width|initial-scale)\s*=/i.test(entry);
              }).filter(function (entry) { return entry.trim() !== ''; });
              var content = ['width=$width', 'initial-scale=$scale'].concat(extra).join(',');
              if (viewport.getAttribute('content') !== content) viewport.setAttribute('content', content);
            })();
        """.trimIndent()
        browser.evaluateJavascript(script, null)
        appliedWidth = width
        appliedPercent = percent
        appliedScale = scale
    }
}
