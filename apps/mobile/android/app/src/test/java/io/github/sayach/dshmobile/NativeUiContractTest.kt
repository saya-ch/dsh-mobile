package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the wiring of the native shell: a helper that exists but is never called is
 * the failure this catches — the pairing-failure callback shipped once as a dead
 * parameter, and every screen still painted its own error.
 */
class NativeUiContractTest {
    private val source = activitySource()

    @Test
    fun everyScreenMountsThroughTheSharedShell() {
        for (screen in listOf("showDeviceList", "showSettings", "showSetup", "showRemoteSetup", "showIrohSetup", "showPairing", "showRestoringTrust")) {
            val body = methodBody(screen)
            assertTrue("$screen must mount through createSetupScreen", body.contains("createSetupScreen("))
        }
        // The browser page keeps its own mount so its WebView never enters a transition layer.
        assertTrue(methodBody("showBrowser").contains("setPageContent(root"))
    }

    @Test
    fun depthDrivesTheTransitionDirection() {
        val transitions = methodBody("playPageTransition")
        assertTrue(transitions.contains("depth > pageDepth"))
        assertTrue("the system animation setting must be honoured", transitions.contains("areAnimatorsEnabled()"))
    }

    @Test
    fun backgroundLayersAreTiedToTheirView() {
        val tracker = methodBody("trackBackdrop")
        assertTrue("a detach must cancel the animator", tracker.contains("onViewDetachedFromWindow"))
        assertTrue(tracker.contains("animator.cancel()"))
        assertTrue(methodBody("setPageContent").contains("cancelBackdropAnimators()"))
        assertTrue(methodBody("onDestroy").contains("cancelBackdropAnimators()"))
        // The wash has to stay opaque: the waiting layer is drawn over live content.
        assertTrue(methodBody("screenBackground").contains("setColor(getColor(R.color.app_background))"))
    }

    @Test
    fun pairingFailuresReachTheirCaller() {
        val connect = methodBody("connect")
        val calls = Regex("reportPairingFailure\\(").findAll(connect).count()
        assertTrue("connect must route its failures through the hook, found $calls", calls >= 6)
        val showPairing = methodBody("showPairing")
        assertTrue(showPairing.contains("ephemeralFailure"))
        // A key that arrived by scan or paste returns to its source; a typed one stays.
        assertTrue(showPairing.contains("if (autoConnect)"))
        assertTrue(showPairing.contains("leaveForm()"))
    }

    @Test
    fun sheetsCarryTheirOwnAccessibilityAndLifetime() {
        val sheet = methodBody("showBottomSheet")
        assertTrue("a long sheet must scroll", sheet.contains("ScrollView(this)"))
        assertTrue(sheet.contains("accessibilityPaneTitle"))
        assertTrue("an open sheet must not outlive the activity", sheet.contains("isFinishing || isDestroyed"))
        assertTrue(sheet.contains("activeSheet = dialog"))
        val choice = methodBody("showChoiceSheet")
        assertTrue("a choice row exposes its selection", choice.contains("isSelected = index == selected"))
        assertTrue("a choice sheet needs a way out", choice.contains("R.string.cancel"))
        assertTrue(methodBody("onPause").contains("dismissActiveSheet()"))
    }

    @Test
    fun destructiveActionsUseTheirOwnFill() {
        assertTrue(source.contains("R.color.app_danger_fill"))
        assertTrue(source.contains("R.color.app_danger_text"))
    }

    @Test
    fun theFullResetStaysReachable() {
        // The screen rebuild once dropped the entry point and left the routine behind as dead code.
        assertTrue(methodBody("showSettings").contains("confirmClearSiteData()"))
        val confirm = methodBody("confirmClearSiteData")
        assertTrue(confirm.contains("clearSiteData()"))
        assertTrue("the reset must ask first", confirm.contains("R.string.cancel"))
        val reset = methodBody("clearSiteData")
        assertTrue(reset.contains("clearBootAssetStore()"))
        assertTrue("a failed credential clear aborts the whole reset", reset.contains("} == null) return"))
    }

    @Test
    fun accessibilityLabelsAreTemplatesNotConcatenatedPunctuation() {
        assertTrue(source.contains("R.string.settings_row_accessibility"))
        assertTrue(!source.contains("+ \"，\" +"))
    }

    private fun activitySource(): String =
        sourceFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()

    /** Body of one member, from its signature to the next member at the same indent. */
    private fun methodBody(name: String): String {
        val start = source.indexOf("private fun $name(").takeIf { it >= 0 }
            ?: source.indexOf("override fun $name(")
        assertTrue("$name not found", start >= 0)
        val next = Regex("\\n    (?:private|internal|protected|override|public) ")
            .find(source, start + 10) ?: return source.substring(start)
        return source.substring(start, next.range.first)
    }

    private fun sourceFile(path: String): File =
        generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base ->
                listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
                    .map { File(base, "$it/$path") }
            }
            .first { it.isFile }
}
