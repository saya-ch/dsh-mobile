package io.github.sayach.dshmobile

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * Picture-in-picture only floats a live DSH page: a floating device list or setup
 * form would be a window the user cannot use, so the policy refuses those screens.
 */
class PictureInPictureTest {
    @Test
    fun onlyALiveBrowserPageFloats() {
        assertTrue(PictureInPicturePolicy.shouldEnter(
            enabled = true, browserPageVisible = true, sdkInt = 34,
            finishingOrDestroyed = false, alreadyInPictureInPicture = false,
        ))
    }

    @Test
    fun theDeviceListAndSetupScreensNeverFloat() {
        assertFalse(PictureInPicturePolicy.shouldEnter(
            enabled = true, browserPageVisible = false, sdkInt = 34,
            finishingOrDestroyed = false, alreadyInPictureInPicture = false,
        ))
    }

    @Test
    fun theSettingOffLeavesTheAppAlone() {
        assertFalse(PictureInPicturePolicy.shouldEnter(
            enabled = false, browserPageVisible = true, sdkInt = 34,
            finishingOrDestroyed = false, alreadyInPictureInPicture = false,
        ))
    }

    @Test
    fun unsupportedPlatformsAndFinishingActivitiesAreRefused() {
        assertFalse("API 26 is the first release with picture-in-picture", PictureInPicturePolicy.shouldEnter(
            enabled = true, browserPageVisible = true, sdkInt = PictureInPicturePolicy.MIN_SDK - 1,
            finishingOrDestroyed = false, alreadyInPictureInPicture = false,
        ))
        assertTrue(PictureInPicturePolicy.shouldEnter(
            enabled = true, browserPageVisible = true, sdkInt = PictureInPicturePolicy.MIN_SDK,
            finishingOrDestroyed = false, alreadyInPictureInPicture = false,
        ))
        assertFalse(PictureInPicturePolicy.shouldEnter(
            enabled = true, browserPageVisible = true, sdkInt = 34,
            finishingOrDestroyed = true, alreadyInPictureInPicture = false,
        ))
        assertFalse("a second request would resize the window the user already has", PictureInPicturePolicy.shouldEnter(
            enabled = true, browserPageVisible = true, sdkInt = 34,
            finishingOrDestroyed = false, alreadyInPictureInPicture = true,
        ))
    }

    @Test
    fun theAspectRatioFollowsThePageAndStaysWithinPlatformBounds() {
        fun ratio(width: Int, height: Int): Double {
            val (w, h) = PictureInPicturePolicy.aspectRatio(width, height)
            return w.toDouble() / h.toDouble()
        }
        assertEquals(16.0 / 9.0, ratio(1920, 1080), 1e-9)
        assertEquals(9.0 / 16.0, ratio(1080, 1920), 1e-9)
        assertEquals(3.0 / 4.0, ratio(900, 1200), 1e-9)
        // A degenerate measurement must not reach the platform as a zero ratio.
        assertEquals(16 to 9, PictureInPicturePolicy.aspectRatio(0, 0))
        assertEquals(16 to 9, PictureInPicturePolicy.aspectRatio(-5, 120))
        assertTrue("an extreme ratio is clamped rather than passed through", ratio(4000, 1000) <= 2.39)
        assertTrue("the clamp is symmetric", ratio(1000, 4000) >= 1.0 / 2.39)
    }

    @Test
    fun theManifestDeclaresPictureInPictureOnTheActivityThatOwnsThePage() {
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(sourceFile("AndroidManifest.xml"))
        val activities = doc.getElementsByTagName("activity")
        val main = (0 until activities.length).map { activities.item(it) as Element }
            .single { it.getAttributeNS(ANDROID_NAMESPACE, "name") == ".MainActivity" }
        assertEquals("true", main.getAttributeNS(ANDROID_NAMESPACE, "supportsPictureInPicture"))
        // The platform refuses the transition when these configuration changes recreate the activity.
        val configChanges = main.getAttributeNS(ANDROID_NAMESPACE, "configChanges").split("|")
        for (required in listOf("screenSize", "smallestScreenSize", "screenLayout", "orientation")) {
            assertTrue("$required must stay in configChanges for picture-in-picture", required in configChanges)
        }
    }

    @Test
    fun thePausedWindowKeepsThePageRunningAndRestoresIt() {
        val source = sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()
        val pause = source.substringAfter("override fun onPause()").substringBefore("override fun onDestroy()")
        assertTrue(
            "pausing the WebView would freeze the floating window",
            pause.contains("if (!pictureInPictureRequested && !isInPictureInPictureMode) webView?.onPause()"),
        )
        val changed = source.substringAfter("override fun onPictureInPictureModeChanged")
            .substringBefore("override fun onPause()")
        assertTrue("returning to full screen must resume the page", changed.contains("webView?.onResume()"))
        assertTrue(
            "the photos-and-pages setting lives in the settings list",
            source.contains("R.drawable.ic_picture_in_picture"),
        )
        assertTrue(source.contains("PREFERENCE_PICTURE_IN_PICTURE"))
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