package io.github.sayach.dshmobile

import android.view.View
import android.view.Window

/** Selects dark status-bar glyphs when the synchronized Web background is light. */
internal fun statusBarUsesDarkIcons(color: Int): Boolean {
    val red = color shr 16 and 0xff
    val green = color shr 8 and 0xff
    val blue = color and 0xff
    return red * 299 + green * 587 + blue * 114 >= 186_000
}

/** Matches status and navigation glyph contrast to the App-owned background strips. */
@Suppress("DEPRECATION")
internal fun applyStatusBarIconContrast(window: Window, color: Int) {
    val darkIcons = statusBarUsesDarkIcons(color)
    val lightBars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
    window.decorView.systemUiVisibility = if (darkIcons) {
        window.decorView.systemUiVisibility or lightBars
    } else {
        window.decorView.systemUiVisibility and lightBars.inv()
    }
}
