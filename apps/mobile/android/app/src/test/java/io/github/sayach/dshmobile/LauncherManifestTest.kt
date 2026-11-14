package io.github.sayach.dshmobile

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** Released MainActivity shortcuts stay callable while aliases own new launcher icon entries. */
class LauncherManifestTest {
    @Test
    fun oldExplicitMainActivityAndNewAliasesRemainUsable() {
        val manifest = sourceFile("AndroidManifest.xml")
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(manifest)
        val activities = doc.getElementsByTagName("activity")
        val main = (0 until activities.length).map { activities.item(it) as Element }
            .single { it.getAttributeNS(ANDROID_NAMESPACE, "name") == ".MainActivity" }
        assertEquals("true", main.getAttributeNS(ANDROID_NAMESPACE, "exported"))
        assertEquals(0, main.getElementsByTagName("intent-filter").length)
        val aliases = doc.getElementsByTagName("activity-alias")
        val entries = (0 until aliases.length).map { aliases.item(it) as Element }
        assertEquals(LauncherIconPolicy.icons.map { ".${it.alias}" }.toSet(),
            entries.map { it.getAttributeNS(ANDROID_NAMESPACE, "name") }.toSet())
        assertEquals(1, entries.count { it.getAttributeNS(ANDROID_NAMESPACE, "enabled") == "true" })
        for (alias in entries) {
            assertEquals(".MainActivity", alias.getAttributeNS(ANDROID_NAMESPACE, "targetActivity"))
            assertEquals("true", alias.getAttributeNS(ANDROID_NAMESPACE, "exported"))
            val intents = alias.getElementsByTagName("intent-filter")
            assertEquals(1, intents.length)
            val filter = intents.item(0) as Element
            assertEquals("android.intent.action.MAIN",
                (filter.getElementsByTagName("action").item(0) as Element).getAttributeNS(ANDROID_NAMESPACE, "name"))
            assertEquals("android.intent.category.LAUNCHER",
                (filter.getElementsByTagName("category").item(0) as Element).getAttributeNS(ANDROID_NAMESPACE, "name"))
        }
    }

    @Test
    fun settingsUseOneGearEntryAndPersistOnlyAfterTheComponentUpdate() {
        val source = sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()
        assertTrue(source.contains("setOnClickListener { showSettings() }"))
        assertTrue(!source.contains("toolbarIconButton(R.drawable.ic_whale_toolbar"))
        val apply = source.substringAfter("private fun applyAppIcon").substringBefore("private fun showIconSettings")
        assertTrue(apply.indexOf("LauncherIconPolicy.switchIcon") < apply.indexOf("putString(PREFERENCE_APP_ICON"))
        assertTrue(apply.contains("setComponentEnabledSettings"))
        assertTrue(apply.contains("Build.VERSION_CODES.TIRAMISU"))
        assertTrue(source.contains("MainActivity::class.java.name.substringBeforeLast('.')"))
    }

    private fun sourceFile(path: String): File {
        val directories = listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main")
        return generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base -> directories.asSequence().map { File(base, "$it/$path") } }
            .first { it.isFile }
    }

    private companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}
