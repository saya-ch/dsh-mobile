package io.github.sayach.dshmobile

import android.content.Context
import java.util.Locale

/**
 * Interface language of the app, mirroring ThemePreference.
 *
 * Chinese stays the source language, so an unknown or unset value follows the system: that is
 * exactly how the app behaved before this setting existed. The eight shipped choices are the
 * same set the plugin and the Windows client offer, and a locale with no resources falls back
 * to Chinese through Android's normal resource resolution.
 */
object LocalePreference {
    const val KEY = "interface_language"
    const val SYSTEM = "system"
    const val CHINESE = "zh"
    const val ITALIAN = "it"
    const val ENGLISH = "en"
    const val JAPANESE = "ja"
    const val KOREAN = "ko"
    const val SPANISH = "es"
    const val FRENCH = "fr"
    const val GERMAN = "de"

    /** Display order in the picker: follow the system first, then the shipped languages. */
    val ALL = listOf(SYSTEM, ITALIAN, ENGLISH, CHINESE, JAPANESE, KOREAN, SPANISH, FRENCH, GERMAN)

    fun sanitize(raw: String?): String = if (raw in ALL) raw!! else SYSTEM

    /**
     * A base context whose configuration carries the chosen locale.
     *
     * Returning the original context for "system" matters: writing an explicit locale on top
     * of the system one would stop the app from following the user's language changes made
     * outside the app.
     */
    fun wrap(base: Context, value: String): Context {
        val mode = sanitize(value)
        if (mode == SYSTEM) return base
        val configuration = base.resources.configuration
        configuration.setLocale(Locale.forLanguageTag(mode))
        return base.createConfigurationContext(configuration)
    }
}
