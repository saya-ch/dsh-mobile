package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Guards the icon picker's labelling: the policy owns the keys and the artwork, and
 * the screen must resolve each key to its own caption. A new icon that forgets its
 * mapping would silently fall back to the mascot name.
 */
class LauncherIconLabelTest {
    @Test
    fun everyIconKeyIsMappedAndDistinct() {
        val source = sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()
        val mapping = source.substringAfter("private fun iconLabelResource(key: String): Int")
            .substringBefore("private fun showIconSettings(")
        assertTrue("iconLabelResource must exist", mapping.isNotEmpty())

        val mapped = Regex("\"([a-z_]+)\" -> R\\.string\\.(icon_choice_[a-z_]+)")
            .findAll(mapping)
            .associate { it.groupValues[1] to it.groupValues[2] }

        val keys = LauncherIconPolicy.icons.map { it.key }
        for (key in keys) {
            assertTrue("icon key $key has no caption", mapped.containsKey(key))
        }
        assertEquals("the mapping has stale keys", keys.toSet(), mapped.keys)
        // one caption per key: two icons must never read the same
        assertEquals("two icons share a caption", keys.size, mapped.values.toSet().size)
    }

    @Test
    fun everyCaptionExistsInEveryLocale() {
        val source = sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()
        val mapping = source.substringAfter("private fun iconLabelResource(key: String): Int")
            .substringBefore("private fun showIconSettings(")
        val names = Regex("R\\.string\\.(icon_choice_[a-z_]+)").findAll(mapping)
            .map { it.groupValues[1] }
            .toSet()
        assertTrue(names.isNotEmpty())
        for (locale in listOf("values", "values-zh-rCN", "values-it", "values-ja", "values-ko", "values-es", "values-fr", "values-de")) {
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(sourceFile("res/$locale/strings.xml"))
            val nodes = document.getElementsByTagName("string")
            val present = (0 until nodes.length).map { nodes.item(it) as Element }
                .map { it.getAttribute("name") }
                .toSet()
            for (name in names) {
                assertTrue("$locale is missing $name", present.contains(name))
            }
        }
    }

    @Test
    fun theSettingsSummaryUsesItsOwnShortCaptions() {
        // Trimming a localized sentence produced " (occhiolino)" in Italian; the summary
        // owns a short caption per key instead of rewriting another locale's wording.
        val source = sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()
        assertTrue("the summary must not trim the picker caption", !source.contains("Mascotte balena DSH\")"))
        val settings = source.substringAfter("private fun showSettings(").substringBefore("private fun themeMode(")
        assertTrue(settings.contains("iconShortLabelResource("))

        val mapping = source.substringAfter("private fun iconShortLabelResource(key: String): Int")
            .substringBefore("private fun showIconSettings(")
        val names = Regex("R\\.string\\.(icon_short_[a-z_]+)").findAll(mapping)
            .map { it.groupValues[1] }
            .toSet()
        assertEquals("one short caption per icon", LauncherIconPolicy.icons.size, names.size)

        for (locale in listOf("values", "values-zh-rCN", "values-it", "values-ja", "values-ko", "values-es", "values-fr", "values-de")) {
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(sourceFile("res/$locale/strings.xml"))
            val nodes = document.getElementsByTagName("string")
            val entries = (0 until nodes.length).map { nodes.item(it) as Element }
                .filter { it.getAttribute("name").startsWith("icon_short_") }
            val present = entries.map { it.getAttribute("name") }.toSet()
            for (name in names) {
                assertTrue("$locale is missing $name", present.contains(name))
            }
            assertEquals("$locale short captions must differ", names.size, entries.map { it.textContent.trim() }.toSet().size)
        }
    }

    @Test
    fun artworkNamesExistForEveryIcon() {
        // The mascot art ships as density mipmaps; the whale marks are single nodpi drawables.
        val roots = listOf("res/mipmap-xxxhdpi", "res/mipmap-xxhdpi", "res/mipmap-mdpi", "res/drawable-nodpi")
            .map { resDir(it) }
        for (icon in LauncherIconPolicy.icons) {
            val found = roots.any { root -> File(root, "${icon.mipmap}.png").isFile }
            assertTrue("no artwork for ${icon.key} (${icon.mipmap})", found)
        }
    }

    private fun resDir(path: String): File =
        generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base ->
                listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
                    .map { File(base, "$it/$path") }
            }
            .first { it.isDirectory }

    private fun sourceFile(path: String): File =
        generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base ->
                listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
                    .map { File(base, "$it/$path") }
            }
            .first { it.isFile }
}
