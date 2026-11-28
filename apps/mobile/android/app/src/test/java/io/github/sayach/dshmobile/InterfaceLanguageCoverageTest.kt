package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The language setting has to reach the whole app, not just the settings screen that sets it.
 *
 * Two kinds of component can silently miss it: a second Activity, which needs the same
 * `attachBaseContext` treatment as MainActivity, and a Service, which has no such hook and so
 * must resolve its strings through [LocalePreference.resources]. Both are user-visible — the
 * scanner's hint, the always-on notification and the channel name in Android's own settings —
 * and neither has any other way to notice the choice.
 */
class InterfaceLanguageCoverageTest {
    @Test
    fun everyActivityAppliesTheChosenLanguage() {
        val activities = sourceFiles()
            .filter { file -> Regex("""class\s+\w+\s*:\s*Activity\b""").containsMatchIn(file.readText()) }
        assertTrue("expected to find the app's activities", activities.isNotEmpty())
        for (file in activities) {
            val source = file.readText()
            val attach = member(source, "override fun attachBaseContext(")
            assertTrue(
                "${file.name} must apply the chosen language in attachBaseContext",
                attach.contains("LocalePreference.wrap("),
            )
            assertTrue(
                "${file.name} must read the stored language from the shared preferences",
                attach.contains("LocalePreference.PREFERENCES_NAME") || attach.contains("PREFERENCES_NAME"),
            )
        }
    }

    @Test
    fun componentsWithoutAnAttachHookResolveStringsThroughThePreference() {
        // A Service cannot wrap its context, so a bare getString there would always resolve in
        // the system language however the user set the app.
        val services = sourceFiles().filter { file ->
            Regex("""class\s+\w+\s*:\s*Service\b""").containsMatchIn(file.readText())
        }
        assertTrue("expected to find the app's services", services.isNotEmpty())
        for (file in services) {
            val source = file.readText()
            val plain = Regex("""(?<!localeResources\.)(?<!resources\.)getString\(R\.string""")
                .findAll(source).count()
            assertEquals(
                "${file.name} must not read user-visible strings in the system language",
                0,
                plain,
            )
            assertTrue(
                "${file.name} must resolve through LocalePreference.resources",
                source.contains("LocalePreference.resources("),
            )
        }
    }

    @Test
    fun theNotificationChannelsFollowTheLanguageToo() {
        // Channel names and descriptions are shown by Android itself, so they need the wrapped
        // resources as well; re-creating an existing channel is what updates them.
        val publisher = sourceFile("TaskNotificationPublisher.kt")
        assertTrue(
            "TaskNotificationPublisher must localise its channel",
            publisher.contains("LocalePreference.resources(context)"),
        )
        val service = sourceFile("BackgroundNotificationService.kt")
        assertTrue(
            "the background channel must be localised",
            service.contains("localisedString(R.string.notification_channel_background)")
                || service.contains("localeResources.getString(R.string.notification_channel_background)"),
        )
    }

    @Test
    fun theSharedPreferencesNameHasOneOwner() {
        // The scanner and the service read the file without going through MainActivity, so the
        // name must not drift between the two declarations.
        assertEquals("dsh_mobile", LocalePreference.PREFERENCES_NAME)
        val activity = sourceFile("MainActivity.kt")
        assertTrue(
            "MainActivity must reuse the constant rather than repeat the literal",
            activity.contains("const val PREFERENCES_NAME = LocalePreference.PREFERENCES_NAME"),
        )
    }

    private fun sourceFiles(): List<File> {
        for (root in listOf("app/src/main", "src/main", ".")) {
            val directory = File(root, "java/io/github/sayach/dshmobile")
            if (directory.isDirectory) {
                return directory.listFiles { file -> file.extension == "kt" }?.toList() ?: emptyList()
            }
        }
        throw AssertionError("cannot locate the Kotlin sources")
    }

    private fun sourceFile(name: String): String {
        for (root in listOf("app/src/main", "src/main", ".")) {
            val file = File(root, "java/io/github/sayach/dshmobile/$name")
            if (file.exists()) return file.readText()
        }
        throw AssertionError("cannot locate $name")
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