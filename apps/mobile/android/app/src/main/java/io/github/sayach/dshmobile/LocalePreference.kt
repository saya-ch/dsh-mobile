package io.github.sayach.dshmobile

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * Interface language of the app, mirroring ThemePreference.
 *
 * An unknown or unset value follows the system, which is how the app behaved before this
 * setting existed. Note which way a miss falls: the default resource folder `values/` holds
 * English, not Chinese — `values-zh-rCN` is the Chinese translation — so a mis-mapped locale
 * shows English rather than Chinese. That is why CHINESE is resolved to a region-qualified
 * tag in [wrap] instead of relying on ICU likely-subtags.
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
    fun wrap(base: Context, value: String?): Context {
        val mode = sanitize(value)
        if (mode == SYSTEM) return base
        // A defensive copy: Resources.getConfiguration() is documented as read-only and
        // ResourcesImpl returns its own instance, so mutating it in place would rewrite the
        // caller's configuration — and for "system" the caller is the real base context.
        val configuration = Configuration(base.resources.configuration)
        // "zh" would rely on ICU likely-subtags to reach values-zh-rCN; naming the region
        // makes it an exact match instead.
        configuration.setLocale(if (mode == CHINESE) Locale.forLanguageTag("zh-CN")
                                else Locale.forLanguageTag(mode))
        return base.createConfigurationContext(configuration)
    }
}
