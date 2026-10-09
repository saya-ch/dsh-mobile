package io.github.sayach.dshmobile

import kotlin.math.max

/** Per-edge safe-area offsets supplied by Android system UI. */
internal data class SafeAreaEdges(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
) {
    /**
     * Combines independently reported inset sources.
     *
     * @param other another inset source for the same window.
     * @return the largest occupied distance on every edge.
     */
    fun union(other: SafeAreaEdges): SafeAreaEdges = SafeAreaEdges(
        left = max(left, other.left),
        top = max(top, other.top),
        right = max(right, other.right),
        bottom = max(bottom, other.bottom),
    )
}

/** Returns keyboard-only overlap, excluding the persistent system navigation edge. */
internal fun additionalImeInset(coveredBottom: Int, webSafeBottom: Int): Int =
    max(0, coveredBottom - webSafeBottom)

/** Fits native setup cards inside the current safe window, including split-screen resizing. */
internal fun setupCardWidth(availableWidth: Int, horizontalGutter: Int, maximumWidth: Int): Int =
    (availableWidth - 2 * horizontalGutter).coerceIn(0, maximumWidth)

/** Immutable content padding captured before system insets are installed. */
internal data class ContentPadding(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
) {
    /**
     * Offsets the original content padding by the current safe area.
     *
     * @param safeArea the latest complete set of system offsets.
     * @return padding for the current inset dispatch.
     */
    fun withSafeArea(safeArea: SafeAreaEdges): ContentPadding = ContentPadding(
        left = left + safeArea.left,
        top = top + safeArea.top,
        right = right + safeArea.right,
        bottom = bottom + safeArea.bottom,
    )
}
