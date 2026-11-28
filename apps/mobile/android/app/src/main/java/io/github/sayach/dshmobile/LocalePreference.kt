package io.github.sayach.dshmobile

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
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
    /**
     * The preferences file the app already uses for every setting.
     *
     * It lives here rather than in MainActivity's private companion so that a second screen —
     * the scanner — and the notification service can read the chosen language without going
     * through the activity.
     */
    const val PREFERENCES_NAME = "dsh_mobile"

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

    /** The stored choice, read from the same preferences file the settings page writes. */
    fun stored(base: Context): String {
        val preferences = base.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        return sanitize(preferences.getString(KEY, null))
    }

    /**
     * Resources that resolve in the chosen language, for components that cannot wrap their
     * context.
     *
     * An Activity resolves a language through [wrap] in `attachBaseContext`, which runs before
     * any view exists. A Service has no such hook, and its notifications and channel names are
     * read straight from the Service context, so those call sites ask for these resources
     * explicitly. Falling back to `base.resources` for "system" keeps that path identical to
     * the Activity path.
     */
    fun resources(base: Context): Resources = wrap(base, stored(base)).resources
}
