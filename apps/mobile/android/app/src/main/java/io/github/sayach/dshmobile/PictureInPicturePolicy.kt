package io.github.sayach.dshmobile

/**
 * Picture-in-picture is only meaningful while a DSH page is on screen: the device
 * list and the setup screens are native pages that the user is done with, so a
 * floating copy of them would be noise. Entering also has to survive the platform
 * rules (API 26+, activity resumed, not finishing).
 */
object PictureInPicturePolicy {
    const val MIN_SDK = 26

    /** Whether leaving the app should float the current DSH page. */
    fun shouldEnter(
        enabled: Boolean,
        browserPageVisible: Boolean,
        sdkInt: Int,
        finishingOrDestroyed: Boolean,
        alreadyInPictureInPicture: Boolean,
    ): Boolean = enabled && browserPageVisible && sdkInt >= MIN_SDK && !finishingOrDestroyed && !alreadyInPictureInPicture

    /**
     * A landscape page is wider than tall, and the floating window should not be a
     * letterboxed sliver of it. Clamped so extreme aspect ratios stay usable.
     */
    fun aspectRatio(width: Int, height: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 16 to 9
        var w = width
        var h = height
        val ratio = w.toDouble() / h.toDouble()
        if (ratio > 2.39) w = (h * 2.39).toInt()
        if (ratio < 1.0 / 2.39) h = (w * 2.39).toInt()
        return w.coerceAtLeast(1) to h.coerceAtLeast(1)
    }
}
