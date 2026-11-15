package io.github.sayach.dshmobile

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The palette has to be decided before the first view exists, so the wiring is pinned
 * here rather than behind a UI test: a preference that is saved but never reaches
 * `attachBaseContext` would leave the row doing nothing at all.
 */
class ThemePreferenceTest {
    @Test
    fun explicitChoicesSurviveAndAnythingElseFollowsTheSystem() {
        assertEquals(ThemePreference.LIGHT, ThemePreference.sanitize("light"))
        assertEquals(ThemePreference.DARK, ThemePreference.sanitize("dark"))
        assertEquals(ThemePreference.SYSTEM, ThemePreference.sanitize("system"))
        assertEquals(ThemePreference.SYSTEM, ThemePreference.sanitize(null))
        assertEquals(ThemePreference.SYSTEM, ThemePreference.sanitize(""))
        assertEquals(ThemePreference.SYSTEM, ThemePreference.sanitize("DARK"))
        assertEquals(ThemePreference.SYSTEM, ThemePreference.sanitize("auto"))
    }

    @Test
    fun onlyExplicitChoicesPinANightBit() {
        assertNull("following the system must not override the configuration", ThemePreference.nightMode("system"))
        assertNull(ThemePreference.nightMode(null))
        val light = ThemePreference.nightMode("light")
        val dark = ThemePreference.nightMode("dark")
        assertNotNull(light)
        assertNotNull(dark)
        assertTrue("the two choices must not collapse into one bit", light != dark)
    }

    @Test
    fun theActivityResolvesThePaletteBeforeCreatingViews() {
        val source = activitySource()
        val attach = member(source, "override fun attachBaseContext(")
        assertTrue(attach.contains("ThemePreference.wrap("))
        assertTrue(attach.contains("ThemePreference.sanitize("))
        assertTrue("the stored value is read from the same preferences file", attach.contains("PREFERENCES_NAME"))
        assertTrue(
            "attachBaseContext must run before anything inflates views",
            source.indexOf("override fun attachBaseContext(") < source.indexOf("override fun onCreate("),
        )
    }

    @Test
    fun theSettingsRowOffersAllThreeChoicesAndRecreates() {
        val source = activitySource()
        val settings = member(source, "private fun showSettings(")
        assertTrue("the row needs an entry point", settings.contains("showThemeSettings()"))
        assertTrue(settings.contains("R.string.theme_title"))
        val sheet = member(source, "private fun showThemeSettings(")
        for (mode in listOf("ThemePreference.SYSTEM", "ThemePreference.LIGHT", "ThemePreference.DARK")) {
            assertTrue("$mode must be offered", sheet.contains(mode))
        }
        assertTrue(sheet.contains("showChoiceSheet("))
        val apply = member(source, "private fun applyThemeMode(")
        assertTrue(apply.contains("ThemePreference.KEY"))
        assertTrue("a saved palette only takes effect after a rebuild", apply.contains("recreate()"))
        assertTrue("the user must land back on the settings page", apply.contains("PREFERENCE_REOPEN_SETTINGS"))
        assertTrue(member(source, "override fun onCreate(").contains("showSettings(animate = false)"))
    }

    @Test
    fun theChoiceIsCaptionedAndIconedInEveryLocale() {
        for (locale in listOf("values", "values-zh-rCN", "values-it")) {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(resFile("res/$locale/strings.xml"))
            val strings = doc.getElementsByTagName("string")
            val names = (0 until strings.length).map { strings.item(it).attributes.getNamedItem("name").nodeValue }
            for (key in listOf("theme_title", "theme_follow_system", "theme_light", "theme_dark")) {
                assertEquals("$locale:$key", 1, names.count { it == key })
            }
        }
        assertTrue(resFile("res/drawable/ic_brightness.xml").isFile)
    }

    private fun activitySource(): String = resFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()

    /** One member's source, from its signature to the next member at the same indent. */
    private fun member(text: String, signature: String): String {
        val start = text.indexOf(signature)
        assertTrue("$signature not found", start >= 0)
        val next = Regex("\\n    (?:private|internal|protected|override|public) ").find(text, start + signature.length)
        return text.substring(start, next?.range?.first ?: text.length)
    }

    private fun resFile(path: String): File {
        val directories = listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main")
        return generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base -> directories.asSequence().map { File(base, "$it/$path") } }
            .first { it.isFile }
    }
}
