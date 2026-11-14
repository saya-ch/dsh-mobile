package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdateCheckerTest {
    private fun descriptor(
        version: String = "0.7.5",
        versionCode: Int = 90,
        releaseTag: String = "android-v0.7.5",
    ): ByteArray = """{"version":"$version","versionCode":$versionCode,"releaseTag":"$releaseTag"}""".toByteArray()

    @Test
    fun parsesACompletePublishedDescriptor() {
        assertEquals(AppUpdateInfo("0.7.5", 90, "android-v0.7.5"), AppUpdatePolicy.parseDescriptor(descriptor()))
    }

    @Test
    fun rejectsIncompleteOrInconsistentDescriptors() {
        assertNull(AppUpdatePolicy.parseDescriptor("""{"versionCode":90,"releaseTag":"android-v0.7.5"}""".toByteArray()))
        assertNull(AppUpdatePolicy.parseDescriptor(descriptor(versionCode = 0)))
        assertNull(AppUpdatePolicy.parseDescriptor(descriptor(versionCode = -3)))
        assertNull(AppUpdatePolicy.parseDescriptor(descriptor(releaseTag = "android-v0.7.4")))
        assertNull(AppUpdatePolicy.parseDescriptor(descriptor(releaseTag = "v0.7.5")))
        assertNull(AppUpdatePolicy.parseDescriptor(descriptor(version = "0.7")))
        assertNull(AppUpdatePolicy.parseDescriptor("not json".toByteArray()))
        assertNull(AppUpdatePolicy.parseDescriptor(ByteArray(0)))
    }

    @Test
    fun rejectsAnOversizedDescriptor() {
        val oversized = ByteArray(17 * 1024) { ' '.code.toByte() }
        assertNull(AppUpdatePolicy.parseDescriptor(oversized))
    }

    @Test
    fun onlyAHigherBuildNumberIsAnUpdate() {
        val published = AppUpdateInfo("0.7.5", 90, "android-v0.7.5")
        assertTrue(AppUpdatePolicy.isNewer(published, 89))
        assertFalse(AppUpdatePolicy.isNewer(published, 90))
        assertFalse(AppUpdatePolicy.isNewer(published, 91))
    }

    @Test
    fun opensThePublishedReleasePage() {
        assertEquals(
            "https://github.com/saya-ch/dsh-mobile/releases/tag/android-v0.7.5",
            AppUpdatePolicy.releasePageUrl("android-v0.7.5"),
        )
    }
}
