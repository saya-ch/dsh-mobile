package io.github.sayach.dshmobile

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The interface language follows the same contract as the theme: the choice is saved, applied
 * before the first view exists, and rebuilt into effect. Nothing about the Android side of the
 * eight-language release was covered before this test, and the wiring is the part that fails
 * silently — a preference that is written but never reaches `attachBaseContext` leaves the row
 * doing nothing at all.
 */
class LocalePreferenceTest {
    @Test
    fun explicitChoicesSurviveAndAnythingElseFollowsTheSystem() {
        for (mode in LocalePreference.ALL) {
            assertEquals(mode, LocalePreference.sanitize(mode))
        }
        assertEquals(LocalePreference.SYSTEM, LocalePreference.sanitize(null))
        assertEquals(LocalePreference.SYSTEM, LocalePreference.sanitize(""))
        assertEquals(LocalePreference.SYSTEM, LocalePreference.sanitize("EN"))
        assertEquals(LocalePreference.SYSTEM, LocalePreference.sanitize("de-DE"))
        assertEquals(LocalePreference.SYSTEM, LocalePreference.sanitize("not-a-language"))
    }

    @Test
    fun systemIsFirstAndEveryShippedLanguageIsOfferedOnce() {
        assertEquals(LocalePreference.SYSTEM, LocalePreference.ALL.first())
        assertEquals(
            "the picker must not offer a language twice",
            LocalePreference.ALL.size,
            LocalePreference.ALL.toSet().size,
        )
        // System plus the eight languages the plugin and the Windows client also ship.
        assertEquals(9, LocalePreference.ALL.size)
        for (mode in listOf("zh", "en", "it", "ja", "ko", "es", "fr", "de")) {
            assertTrue("$mode must be offered", LocalePreference.ALL.contains(mode))
        }
    }

    @Test
    fun followingTheSystemLeavesTheContextUntouched() {
        // Wrapping here would pin a locale and stop the App reacting to a language change made
        // in Android settings, which is exactly what the default is meant to preserve.
        val preference = LocalePreference
        assertNull(
            "sanitize must not invent a locale",
            if (preference.sanitize(LocalePreference.SYSTEM) == LocalePreference.SYSTEM) null else "unexpected",
        )
    }

    @Test
    fun theActivityResolvesTheLanguageBeforeCreatingViews() {
        val source = activitySource()
        val attach = member(source, "override fun attachBaseContext(")
        assertTrue(attach.contains("LocalePreference.wrap("))
        assertTrue("the stored value is read from the same preferences file", attach.contains("PREFERENCES_NAME"))
        assertTrue("the language key must be the stored one", attach.contains("LocalePreference.KEY"))
        assertTrue(
            "attachBaseContext must run before anything inflates views",
            source.indexOf("override fun attachBaseContext(") < source.indexOf("override fun onCreate("),
        )
    }

    @Test
    fun theSettingsRowOffersEveryLanguageAndRecreates() {
        val source = activitySource()
        val settings = member(source, "private fun showSettings(")
        assertTrue("the row needs an entry point", settings.contains("showLanguageSettings()"))
        assertTrue(settings.contains("R.string.language_title"))

        val sheet = member(source, "private fun showLanguageSettings(")
        assertTrue(sheet.contains("showChoiceSheet("))
        assertTrue("the sheet offers the shipped list", sheet.contains("LocalePreference.ALL"))

        val apply = member(source, "private fun applyInterfaceLanguage(")
        assertTrue(apply.contains("LocalePreference.KEY"))
        assertTrue("a saved language only takes effect after a rebuild", apply.contains("recreate()"))
        assertTrue("the user must land back on the settings page", apply.contains("EXTRA_REOPEN_SETTINGS"))
    }

    @Test
    fun everyLocaleNamesEachLanguageInItsOwnWords() {
        // A picker that writes "Japanese" in the German file asks the user to recognise a
        // foreign word for their own language, so the names must be identical across locales.
        val expected = mapOf(
            "language_italian" to "Italiano",
            "language_english" to "English",
            "language_chinese" to "简体中文",
            "language_japanese" to "日本語",
            "language_korean" to "한국어",
            "language_spanish" to "Español",
            "language_french" to "Français",
            "language_german" to "Deutsch",
        )
        val locales = listOf(
            "values", "values-zh-rCN", "values-it", "values-ja",
            "values-ko", "values-es", "values-fr", "values-de",
        )
        for (locale in locales) {
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(resFile("res/$locale/strings.xml"))
            val strings = document.getElementsByTagName("string")
            val values = mutableMapOf<String, String>()
            for (index in 0 until strings.length) {
                val node = strings.item(index)
                values[node.attributes.getNamedItem("name").nodeValue] = node.textContent
            }
            for ((key, name) in expected) {
                assertEquals("$locale:$key", name, values[key])
            }
            // The title and the "follow system" row are translated, so they must not be empty
            // and must not still be the English source in a non-English locale.
            assertTrue("$locale:language_title", values["language_title"]?.isNotEmpty() == true)
            assertTrue("$locale:language_follow_system", values["language_follow_system"]?.isNotEmpty() == true)
            if (locale != "values") {
                assertTrue(
                    "$locale language_title must be translated",
                    values["language_title"] != "Interface language",
                )
            }
        }
    }

    private fun resFile(relative: String): File {
        val candidates = listOf("app/src/main", "src/main", ".")
        for (root in candidates) {
            val file = File(root, relative)
            if (file.exists()) return file
        }
        throw AssertionError("cannot locate $relative")
    }

    private fun activitySource(): String {
        for (root in listOf("app/src/main", "src/main", ".")) {
            val file = File(root, "java/io/github/sayach/dshmobile/MainActivity.kt")
            if (file.exists()) return file.readText()
        }
        throw AssertionError("cannot locate MainActivity.kt")
    }

    /** The text of one function, from its header to the closing brace at the header's indent. */
    private fun member(source: String, header: String): String {
        val start = source.indexOf(header)
        if (start < 0) throw AssertionError("cannot find $header")
        val indent = source.lastIndexOf('\n', start) + 1
        val closing = "\n" + " ".repeat(start - indent) + "}"
        val end = source.indexOf(closing, start)
        if (end < 0) throw AssertionError("cannot find the end of $header")
        return source.substring(start, end)
    }
}
