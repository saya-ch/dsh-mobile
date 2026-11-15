package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Binds the JVM restore gate to the actual Android configuration entry points. */
class RestoreNavigationWiringTest {
    @Test
    fun manualConfigurationCancelsRestoreBeforeRenderingItsForm() {
        val activity = activitySource()
        for (name in listOf("showSetup", "showRemoteSetup", "showPairing")) {
            val body = methodBody(activity, name)
            val cancellation = body.indexOf("cancelRestoreForConfiguration()")
            assertTrue("$name must cancel the old restore before rendering", cancellation >= 0)
            assertTrue("$name must cancel before creating form content", cancellation < body.indexOf("createSetupScreen("))
        }
    }

    @Test
    fun theActivityUsesTheProductionGateForRetriesRenewalAndCookieCallbacks() {
        val activity = activitySource()
        val cancellation = methodBody(activity, "cancelRestoreForConfiguration")
        assertTrue(cancellation.contains("withdrawConnectionAttempt()"))
        assertTrue(cancellation.contains("cancelAutomaticRecovery()"))
        assertTrue(cancellation.contains("invalidateRestoreAttempts()"))
        assertTrue(methodBody(activity, "beginRestoreAttempt").contains("restoreAttemptGate.begin()"))
        assertTrue(methodBody(activity, "invalidateRestoreAttempts").contains("restoreAttemptGate.invalidate()"))
        assertTrue(methodBody(activity, "cancelAutomaticRecovery").contains("restoreAttemptGate.cancelRetry()"))
        assertTrue(methodBody(activity, "scheduleAutomaticRecovery").contains("restoreAttemptGate.retryCallback"))
        val restore = methodBody(activity, "restoreTrustedDevice")
        assertTrue(restore.contains("runOnUiThread(restoreAttemptGate.callback(generation)"))
        assertTrue(restore.contains("isCurrent = { restoreAttemptGate.isCurrent(generation) && connectionAttempts.isCurrent(attempt) && requestIsCurrent() && claimSuccess() }"))
    }

    @Test
    fun repeatedMainDocumentFailuresCoalesceUntilTheCurrentRenewalInstallsItsCookies() {
        val activity = activitySource()
        val schedule = methodBody(activity, "scheduleAutomaticRecovery")
        assertTrue(schedule.indexOf("restoreAttemptGate.restorePending") < schedule.indexOf("recoveryHandler.postDelayed"))
        val restore = methodBody(activity, "restoreTrustedDevice")
        val claim = restore.indexOf("restoreAttemptGate.claimRestore(generation)")
        val physical = restore.indexOf("restoreWorkGate.submit(")
        val renew = restore.indexOf("NativeAuthClient.renew(")
        assertTrue(claim >= 0 && physical > claim && renew > physical)
        assertFalse("The restore worker must not bypass the per-credential physical slot", restore.contains("restoreExecutor.execute"))
        val cookies = restore.substringAfter("installNativeSession(")
        assertTrue(cookies.indexOf("restoreAttemptGate.completeRestore(generation)") < cookies.indexOf("showBrowser("))
        assertTrue(cookies.contains("isCurrent = { restoreAttemptGate.isCurrent(generation) && connectionAttempts.isCurrent(attempt) && requestIsCurrent() && claimSuccess() }"))
    }

    @Test
    fun nativeRestoreRejectionAndFailureReleaseLogicalOwnershipBeforeSchedulingRetry() {
        val restore = methodBody(activitySource(), "restoreTrustedDevice")
        val rejection = restore.substringAfter("onRejected = {").substringBefore(") restore@")
        assertTrue(rejection.indexOf("restoreAttemptGate.completeRestore(generation)") < rejection.indexOf("onFailure("))
        // Restrict to the final disposition rather than a nested status-selection branch.
        val finalFailure = restore.substringBefore("onFailure(finalDisposition)")
        assertTrue(finalFailure.trimEnd().endsWith("restoreAttemptGate.completeRestore(generation)"))
    }

    @Test
    fun anEndedConnectionCannotLeaveALogicalRestoreOwnerAfterACookieCallbackIsWithdrawn() {
        val finish = methodBody(activitySource(), "finishConnectionAttempt")
        assertTrue(finish.indexOf("connectionAttempts.finish(attempt)") < finish.indexOf("restoreAttemptGate.completeRestore(restoreGeneration)"))
        assertTrue(finish.indexOf("restoreAttemptGate.completeRestore(restoreGeneration)") < finish.indexOf("pendingConnection = null"))
        val restore = methodBody(activitySource(), "restoreTrustedDevice")
        val result = restore.substringAfter("val failureKind =").substringBefore("if (deviceKey != null)")
        assertTrue(result.contains("!connectionAttempts.isCurrent(attempt)"))
        assertTrue(result.contains("restoreAttemptGate.completeRestore(generation)"))
    }

    @Test
    fun webViewCallbacksCannotRestoreOrChangeTheStateOfAReplacementBrowser() {
        val browser = methodBody(activitySource(), "showBrowser")
        val owner = browser.substringAfter("fun ownsBrowser()").substringBefore("val secureClient =")
        assertTrue(owner.contains("webView === browser"))
        assertTrue(owner.contains("gatewayOrigin == origin"))
        assertTrue(owner.contains("!isFinishing && !isDestroyed"))
        assertFalse("A retained WebView must remain owned after normal Session renewal", owner.contains("restoreGeneration"))
        val callbacks = browser.substringAfter("val secureClient = SecureWebViewClient(").substringBefore("secureWebViewClient = secureClient")
        for (name in listOf("openExternal", "onBlocked", "onFailure", "onRendererGone", "onTopLevelUrlChanged", "onLoaded")) {
            assertTrue("Missing callback owner $name", callbacks.contains("$name ="))
            val body = callbacks.substringAfter("$name =").substringBefore("\n            },")
            assertTrue("Late $name must not act on the current Activity browser", body.contains("if (ownsBrowser()"))
        }
    }

    private fun methodBody(source: String, name: String): String {
        val declaration = "private fun $name("
        assertTrue("Missing owning Activity method $name", source.contains(declaration))
        return source.substringAfter(declaration).substringBefore("\n    private fun ")
    }

    private fun activitySource(): String {
        val path = "java/io/github/sayach/dshmobile/MainActivity.kt"
        val directories = listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main")
        return generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base -> directories.asSequence().map { File(base, "$it/$path") } }
            .first { it.isFile }.readText()
    }
}
