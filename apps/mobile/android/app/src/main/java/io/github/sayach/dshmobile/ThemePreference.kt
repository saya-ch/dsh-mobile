package io.github.sayach.dshmobile

import android.content.Context
import android.content.res.Configuration

/**
 * The App paints both palettes itself, so the setting only decides which one the
 * resources resolve to before the first view is created. Anything other than an
 * explicit choice follows the system, which also keeps the previous behaviour for
 * everyone who never opens the row.
 */
object ThemePreference {
    const val KEY = "theme_mode"
    const val SYSTEM = "system"
    const val LIGHT = "light"
    const val DARK = "dark"

    fun sanitize(raw: String?): String = when (raw) {
        LIGHT, DARK -> raw
        else -> SYSTEM
    }

    /** The night bit to force, or null when the system decides. */
    fun nightMode(mode: String?): Int? = when (sanitize(mode)) {
        LIGHT -> Configuration.UI_MODE_NIGHT_NO
        DARK -> Configuration.UI_MODE_NIGHT_YES
        else -> null
    }

    /**
     * A base context whose configuration carries the chosen night mode. The Activity
     * must pass its result to `attachBaseContext`; recreating afterwards is what makes
     * an already-drawn screen pick the new palette up.
     */
    fun wrap(base: Context, mode: String): Context {
        val night = nightMode(mode) ?: return base
        val configuration = Configuration(base.resources.configuration)
        configuration.uiMode = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
        return base.createConfigurationContext(configuration)
    }
}
