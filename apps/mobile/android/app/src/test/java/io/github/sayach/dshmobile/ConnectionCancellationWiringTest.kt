package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Complements controller/network tests by checking their actual Activity entry points. */
class ConnectionCancellationWiringTest {
    @Test fun cancellationIsVisibleImmediatelyAndSystemBackUsesTheSameOwner() {
        val source = activitySource()
        val start = method(source, "startConnectionAttempt")
        assertTrue(start.contains("background = screenBackground()"))
        assertTrue(start.contains("ProgressBar(this@MainActivity)"))
        assertTrue(Regex("secondaryButton\\(\\s*if \\(preserveBrowser == null\\) R\\.string\\.connection_cancel else R\\.string\\.connection_stop_reconnecting,\\s*48,").containsMatchIn(start))
        assertTrue(start.contains("{ connectionAttempts.cancel(attempt) }"))
        assertTrue(start.contains("attachConnectionWaitingView()"))
        assertTrue(start.contains("isClickable = true"))
        assertTrue(start.contains("isFocusableInTouchMode = true"))
        val withdrawal = start.indexOf("withdrawConnectionAttempt()")
        assertTrue(withdrawal >= 0)
        assertTrue("A new attempt first clears the previous presentation stage", withdrawal < start.indexOf("val waiting ="))
        assertFalse("Connection waiting uses the shared wash, not another modal", start.contains("AlertDialog"))
        assertFalse(source.contains("connectionProgressDialog"))
        assertFalse(start.contains("postDelayed"))
        assertFalse(source.contains("RESTORE_ESCAPE_DELAY_MS"))
        val back = method(source, "handleBack")
        assertTrue(back.indexOf("connectionAttempts.cancel(it)") < back.indexOf("val browser ="))
    }

    @Test fun replacingTheRealPageReattachesOnlyTheWaitingPresentation() {
        val source = activitySource()
        val replace = method(source, "setPageContent")
        val detach = replace.indexOf("detachConnectionWaitingView()")
        val content = replace.indexOf("setContentView(root)")
        val attach = replace.indexOf("attachConnectionWaitingView()")
        assertTrue(detach >= 0)
        assertTrue(content > detach)
        assertTrue(attach > content)
        assertTrue(
            "showRestoringTrust must preserve the waiting presentation across its new root",
            method(source, "showRestoringTrust").contains("createSetupScreen("),
        )
        assertTrue(
            "showBrowser must preserve the waiting presentation across its new root",
            method(source, "showBrowser").contains("setPageContent(root"),
        )
        val presentation = replace + method(source, "detachConnectionWaitingView")
        for (operation in listOf("dismissConnectionProgress()", "pendingConnection =", "loadingConnectionAttempt =", "loadingDocumentGeneration =", "pageReadyCheck =", "connectionAttempts.")) {
            assertFalse("Changing the real root must not withdraw its connection or readiness owner: $operation", presentation.contains(operation))
        }
        val waiting = method(source, "attachConnectionWaitingView")
        assertTrue(waiting.contains("connectionWaitingView ?: return"))
        assertTrue(waiting.contains("pendingConnection ?: return"))
        assertTrue(waiting.contains("connectionAttempts.isCurrent(attempt)"))
        assertTrue(waiting.contains("android.R.id.content"))
        assertTrue(waiting.contains("container.addView(waiting"))
        assertTrue(waiting.contains("ViewGroup.LayoutParams.MATCH_PARENT"))
    }

    @Test fun waitingRestoresUnderlyingAccessibilityAndFocusWithoutOpeningTheKeyboard() {
        val source = activitySource()
        val attach = method(source, "attachConnectionWaitingView")
        val fullscreen = attach.indexOf("if (!connectionPageVisible)")
        assertTrue("Only full-screen waiting may hide the underlying page", fullscreen >= 0)
        assertTrue(fullscreen < attach.indexOf("waitingRootAccessibility[root] = root.importantForAccessibility"))
        assertTrue(attach.contains("waitingRootAccessibility[root] = root.importantForAccessibility"))
        assertTrue(attach.contains("root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS"))
        assertTrue(attach.contains("waitingRootFocusability[root] = root.descendantFocusability"))
        assertTrue(attach.contains("root.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS"))
        assertTrue("Compact cancellation must not steal focus from the visible webpage", Regex("if \\(!connectionPageVisible\\)\\s*(?:\\{\\s*)?waiting\\.requestFocus\\(\\)").containsMatchIn(attach))
        assertFalse("The waiting controls must remain accessible", attach.contains("container.importantForAccessibility ="))
        val detach = method(source, "detachConnectionWaitingView")
        assertTrue(detach.contains("root.importantForAccessibility = previous"))
        assertTrue(detach.contains("root.descendantFocusability = previous"))
        assertTrue(detach.contains("waitingRootAccessibility.clear()"))
        assertTrue(detach.contains("waitingRootFocusability.clear()"))
        assertFalse("Finishing a connection must not summon the composer keyboard", detach.contains("requestFocus()"))
        val dismiss = method(source, "dismissConnectionProgress")
        assertTrue(dismiss.contains("detachConnectionWaitingView()"))
        assertTrue(dismiss.contains("connectionWaitingView = null"))
        assertTrue(dismiss.contains("connectionCancelButton = null"))
        assertTrue(dismiss.contains("connectionPageVisible = false"))
        assertFalse(dismiss.contains("requestFocus()"))
        assertTrue(method(source, "startConnectionAttempt").contains("hideSoftInputFromWindow"))
    }

    @Test fun waitingDoesNotHidePauseOrDestroyThePageWhoseBootItObserves() {
        val source = activitySource()
        for (name in listOf("startConnectionAttempt", "attachConnectionWaitingView", "detachConnectionWaitingView", "setPageContent", "revealConnectionPage")) {
            val presentation = method(source, name)
            for (operation in listOf("destroyWebView(", ".onPause()", ".stopLoading()", "View.GONE", "View.INVISIBLE")) {
                assertFalse("$name must leave the underlying page running: $operation", presentation.contains(operation))
            }
        }
        val waiting = method(source, "startConnectionAttempt")
        assertTrue(waiting.contains("resolveWebViewSafeArea(insets)"))
        assertTrue(waiting.contains("scroll.setPadding(dp(32) + edges.left"))
        val attach = method(source, "attachConnectionWaitingView")
        assertTrue(attach.contains("waiting.dispatchApplyWindowInsets(it)"))
        assertTrue(attach.contains("container.requestApplyInsets()"))
    }

    @Test fun manualTransientFailureCannotLeaveAConnectingLabelWithoutAnActiveRetry() {
        val connect = method(activitySource(), "connectPairedDevice")
        val failed = connect.substringAfter("deviceKey = device.key) { _ ->")
        assertTrue(failed.contains("showDeviceList()"))
        assertTrue(failed.contains("setText(R.string.connection_failed)"))
        assertFalse(failed.contains("!= RestoreFailureDisposition.RETRY_TRANSIENT"))
    }

    @Test fun pairingAndRestorePassCancellationThroughTheirNetworkAndCookieStages() {
        val source = activitySource()
        val pairing = method(source, "connect")
        assertTrue(pairing.indexOf("startConnectionAttempt(") < pairing.indexOf("ioExecutor.execute"))
        assertTrue(pairing.contains("NativeAuthClient.fetchMetadata(origin, attempt.cancellation)"))
        assertTrue(pairing.contains("NativeAuthClient.fetchPairingCa(origin, attempt.cancellation)"))
        assertTrue(pairing.contains("NativeAuthClient.pair(origin, key.token, certificate, key.instanceId, attempt.cancellation)"))
        assertTrue(pairing.contains("cancellation = attempt.cancellation"))
        assertTrue(pairing.contains("accessMode == mode && connectionAttempts.isCurrent(attempt)"))
        val restore = method(source, "restoreTrustedDevice")
        val connectionOwner = restore.indexOf("pendingConnection ?: startConnectionAttempt(")
        val physicalQueue = restore.indexOf("restoreWorkGate.submit(")
        assertTrue(connectionOwner >= 0 && physicalQueue > connectionOwner)
        assertFalse("Cancellation must not bypass the physical restore queue", restore.contains("restoreExecutor.execute"))
        assertTrue(restore.contains("cancellation = attempt.cancellation"))
        assertTrue(restore.contains("LanDiscovery.scan(this, cancellation = attempt.cancellation)"))
        assertFalse("A final asynchronous page probe still owns the connection", restore.contains("if (!recoveryScheduled) finishConnectionAttempt(attempt)"))
    }

    @Test fun initialPageKeepsTheBudgetUntilMountedAndRecoveryDoesNotRestartIt() {
        val source = activitySource()
        val retry = method(source, "scheduleAutomaticRecovery")
        assertTrue(retry.contains("if (pendingConnection == null) startConnectionAttempt(accessMode, preserveBrowser = webView)"))
        val browser = method(source, "showBrowser")
        assertTrue(browser.contains("if (pendingConnection == null) startConnectionAttempt(accessMode)"))
        val loaded = browser.substringAfter("onLoaded = {").substringBefore("secureWebViewClient = secureClient")
        assertTrue(loaded.contains("secureWebViewClient?.currentDocumentGeneration?.let(::inspectVisibleContent)"))
        assertFalse("A retry in the retained WebView must not finish its creation-time owner", loaded.contains("loadAttempt"))
        val readiness = method(source, "finishConnectionWhenPageReady")
        assertTrue(readiness.contains("probeMountedDshPage(browser, origin, INITIAL_DSH_READY_PROBE)"))
        assertTrue(readiness.contains("secureWebViewClient?.confirmContentReady(documentGeneration) == true"))
        assertTrue(readiness.indexOf("confirmContentReady(documentGeneration)") < readiness.indexOf("finishConnectionAttempt(attempt)"))
        assertTrue(readiness.contains("connectionAttempts.isCurrent(attempt)"))
        assertTrue(readiness.contains("loadingConnectionAttempt !== attempt"))
        assertTrue(method(source, "recoverAutomatically").contains("loadingConnectionAttempt = null"))
    }

    @Test fun visibleUsableContentReleasesLoadingWithoutWaitingForAllResources() {
        val source = activitySource()
        val browser = method(source, "showBrowser")
        val visible = browser.substringAfter("onContentVisible = { generation ->").substringBefore("secureWebViewClient = secureClient")
        assertTrue(visible.contains("if (ownsBrowser())"))
        assertTrue(visible.contains("inspectVisibleContent(generation)"))
        val inspection = browser.substringAfter("fun inspectVisibleContent(generation: Int)").substringBefore("if (androidx.webkit.WebViewFeature")
        assertTrue(inspection.contains("loadingConnectionAttempt ?: return"))
        assertFalse(inspection.contains("pendingConnection"))
        assertTrue(inspection.contains("ownsBrowser()"))
        assertTrue(inspection.contains("connectionAttempts.isCurrent(attempt)"))
        assertTrue(inspection.contains("currentDocumentGeneration != generation"))
        assertTrue(inspection.indexOf("ownsBrowser()") < inspection.indexOf("loadingDocumentGeneration = generation"))
        val reveal = inspection.indexOf("revealConnectionPage(browser, attempt, generation)")
        val ready = inspection.indexOf("finishConnectionWhenPageReady(browser, origin, attempt, generation)")
        assertTrue("A committed page is revealed without waiting for its application controls", reveal >= 0)
        assertTrue("DOM readiness completes the connection only after presentation is released", ready > reveal)
        val readiness = method(source, "finishConnectionWhenPageReady")
        assertTrue(readiness.contains("loadingDocumentGeneration != documentGeneration"))
        assertTrue(readiness.contains("secureWebViewClient?.currentDocumentGeneration != documentGeneration"))
        assertTrue(browser.contains("fun withdrawPageReadiness()"))
    }

    @Test fun revealingACommittedPageRetainsCancellationAndItsOriginalConnectionDeadline() {
        val source = activitySource()
        assertTrue(method(source, "revealConnectionPage").contains("showCompactConnectionWaiting(attempt)"))
        val reveal = method(source, "showCompactConnectionWaiting")
        assertTrue(reveal.contains("detachConnectionWaitingView()"))
        assertTrue(reveal.contains("connectionPageVisible = true"))
        assertTrue(reveal.contains("attachConnectionWaitingView()"))
        val compact = reveal.substringAfter("val compact = FrameLayout(this)").substringBefore("connectionPageVisible = true")
        assertFalse("Compact cancellation must not paint over the webpage", compact.contains("setBackgroundColor"))
        assertFalse("An empty part of the compact container must pass touches to the webpage", compact.contains("isClickable = true"))
        assertFalse("Showing compact cancellation must not request webpage focus", compact.contains("isFocusableInTouchMode = true"))
        assertFalse(compact.contains("requestFocus()"))
        assertTrue(reveal.contains("connectionCancelButton"))
        assertTrue(reveal.contains("Gravity.BOTTOM"))
        assertTrue(reveal.contains("Gravity.END"))
        assertTrue(reveal.contains("ViewGroup.LayoutParams.WRAP_CONTENT"))
        assertTrue("The compact button retains initial-connection and reconnect labels", reveal.contains("if (stopReconnecting) R.string.connection_stop_reconnecting else R.string.connection_cancel"))
        assertTrue("The compact button must retain the current attempt's explicit cancellation", Regex("secondaryButton\\([\\s\\S]*?48,\\s*\\) \\{ connectionAttempts.cancel\\(attempt\\) }").containsMatchIn(reveal))
        assertTrue(reveal.indexOf("connectionPageVisible = true") < reveal.indexOf("attachConnectionWaitingView()"))
        for (operation in listOf("finishConnectionAttempt(", "confirmContentReady(", "connectionAttempts.finish(", "dismissConnectionProgress()", "pendingConnection =", "loadingConnectionAttempt =", "pageReadyCheck =", ".stopLoading()")) {
            assertFalse("Revealing committed content is not authentication or application completion: $operation", reveal.contains(operation))
        }
    }

    @Test fun aLateCommitCannotRevealAnotherBrowserDocumentOrThePageOfAPendingNativeRenewal() {
        val reveal = method(activitySource(), "revealConnectionPage")
        val detach = reveal.indexOf("showCompactConnectionWaiting(attempt)")
        assertTrue(detach >= 0)
        for (condition in listOf("webView !== browser", "loadingConnectionAttempt !== attempt", "connectionAttempts.isCurrent(attempt)", "currentDocumentGeneration")) {
            val guard = reveal.indexOf(condition)
            assertTrue("Missing committed-page owner guard: $condition", guard >= 0)
            assertTrue("$condition must be checked before changing the visible page", guard < detach)
        }
        assertFalse("A retained old document cannot reveal or finish a pending native request", reveal.contains("pendingConnection ?:"))
    }

    @Test fun replacingTheDocumentRestoresFullWaitingWithoutResettingTheConnectionBudget() {
        val source = activitySource()
        val restore = method(source, "restoreConnectionWaitingScreen")
        assertTrue(restore.contains("if (!connectionPageVisible) return"))
        assertTrue(restore.contains("detachConnectionWaitingView()"))
        assertTrue(restore.contains("connectionPageVisible = false"))
        assertTrue(restore.contains("connectionWaitingView = connectionFullWaitingView"))
        assertTrue(restore.contains("connectionCancelButton = connectionFullCancelButton"))
        assertTrue(restore.contains("attachConnectionWaitingView()"))
        for (operation in listOf("startConnectionAttempt(", "connectionAttempts.start(", "finishConnectionAttempt(", "confirmContentReady(")) {
            assertFalse("A replacement document keeps its original connection budget: $operation", restore.contains(operation))
        }
        val browser = method(source, "showBrowser")
        assertTrue(browser.contains("restoreConnectionWaitingScreen()"))
        val withdraw = browser.substringAfter("fun withdrawPageReadiness()").substringBefore("fun inspectVisibleContent(")
        assertTrue(withdraw.contains("restoreConnectionWaitingScreen()"))
        val dismiss = method(source, "dismissConnectionProgress")
        assertTrue(dismiss.contains("connectionFullWaitingView = null"))
        assertTrue(dismiss.contains("connectionFullCancelButton = null"))
    }

    @Test fun stoppingRecoveryPreventsLateBrowserFailuresFromOpeningAnotherConnection() {
        val source = activitySource()
        val start = method(source, "startConnectionAttempt")
        assertTrue(start.contains("if (preserveBrowser != null && webView === preserveBrowser) recoveryStoppedBrowser = preserveBrowser"))
        assertTrue(start.contains("cancelAutomaticRecovery()"))
        assertTrue(start.contains("invalidateRestoreAttempts(if (reason == ConnectionAttemptController.Reason.TIMED_OUT) \"timeout\" else \"cancelled\")"))
        assertTrue(start.contains("invalidatePairingAttempts()"))
        val canRecover = method(source, "canRecoverAutomatically")
        val stopped = canRecover.indexOf("if (webView != null && recoveryStoppedBrowser === webView) return false")
        assertTrue(stopped >= 0)
        assertTrue("A stopped browser cannot become recoverable merely because its credential is valid", stopped < canRecover.indexOf("pairedDeviceStore.load()"))
        val browser = method(source, "showBrowser")
        val failed = browser.substringAfter("onFailure = { failure ->").substringBefore("onRendererGone =")
        assertTrue(failed.contains("ownsBrowser() && recoveryStoppedBrowser !== browser"))
        assertTrue(failed.contains("showLoadFailure(failure)"))
        assertTrue("An explicitly opened browser releases the old stop choice", browser.contains("recoveryStoppedBrowser = null"))
    }

    @Test fun stoppingRecoveryLeavesAUsablePageButReturnsFromALostDocument() {
        val source = activitySource()
        assertTrue(method(source, "startConnectionAttempt").contains("returnFromStoppedRecoveryIfPageLost(preserveBrowser)"))
        val fallback = method(source, "returnFromStoppedRecoveryIfPageLost")
        assertTrue(fallback.contains("probeMountedDshPage(browser, origin, INITIAL_DSH_READY_PROBE)"))
        for (condition in listOf("!mounted", "pendingConnection == null", "restoreGeneration == generation", "webView === browser", "browser.url == url", "currentDocumentGeneration == documentGeneration", "gatewayOrigin == origin", "recoveryStoppedBrowser === browser")) {
            assertTrue("A stale stopped-page probe must not replace newer content: $condition", fallback.contains(condition))
        }
        assertTrue(fallback.contains("showConnectionCenter()"))
    }

    @Test fun aSameUrlReplacementWithdrawsTheStoppedDocumentProbeBeforeReturningToTheList() {
        val fallback = method(activitySource(), "returnFromStoppedRecoveryIfPageLost")
        val capture = fallback.indexOf("val documentGeneration = secureWebViewClient?.currentDocumentGeneration ?: return")
        val probe = fallback.indexOf("probeMountedDshPage(browser, origin, INITIAL_DSH_READY_PROBE)")
        val guard = fallback.indexOf("secureWebViewClient?.currentDocumentGeneration == documentGeneration")
        val navigate = fallback.indexOf("showConnectionCenter()")
        assertTrue("Capture the committed document separately from its reusable URL", capture >= 0)
        assertTrue(capture < probe)
        assertTrue("A delayed result checks the document that requested it", guard > probe)
        assertTrue("A same-URL reload must win over the older failed-page result", navigate > guard)
    }

    @Test fun cancellingInitialPageLoadingCannotReturnToADetachedPairingForm() {
        val source = activitySource()
        val start = method(source, "startConnectionAttempt")
        assertTrue(start.contains("connectionCancellationAction = onCancelled"))
        assertTrue(start.contains("returnToOwner?.invoke(reason)"))
        val browser = method(source, "showBrowser")
        assertTrue(browser.contains("connectionCancellationAction = { showConnectionCenter() }"))
        assertTrue(browser.indexOf("connectionCancellationAction =") < browser.indexOf("destroyWebView()"))
        assertTrue(method(source, "finishConnectionAttempt").contains("connectionCancellationAction = null"))
        assertTrue(method(source, "withdrawConnectionAttempt").contains("connectionCancellationAction = null"))
    }

    @Test fun anExplicitRetryOwnsItsLoadingBudgetAndCanReleaseTheStoppedBrowser() {
        val failure = method(activitySource(), "showLoadFailure")
        val retry = failure.substringAfter(".setPositiveButton(R.string.retry)").substringBefore(".setNegativeButton(R.string.edit_connection)")
        val resume = retry.indexOf("recoveryStoppedBrowser = null")
        assertTrue(resume >= 0)
        assertTrue(resume < retry.indexOf("canRecoverAutomatically()"))
        val direct = retry.substringAfter("val target = retryUrl ?: gatewayOrigin?.serialized")
        val start = direct.indexOf("startConnectionAttempt(accessMode)")
        assertTrue(start >= 0)
        assertTrue("Non-renewal retries also need immediate cancellation", start < direct.indexOf("webView?.loadUrl(target)"))
    }

    @Test fun exhaustingRetriesKeepsCancellationUntilTheFinalMountedPageProbeSettles() {
        val source = activitySource()
        val restore = method(source, "restoreTrustedDevice")
        assertFalse(restore.contains("if (!recoveryScheduled) finishConnectionAttempt(attempt)"))
        val failed = restore.substringAfter("onFailure(finalDisposition)").substringBefore("} else {")
        assertFalse("The failure caller owns asynchronous recovery settlement", failed.contains("finishConnectionAttempt"))
        val exhausted = method(source, "finishAutomaticRecoveryAfterRetryBudget")
        val probe = exhausted.indexOf("probeMountedDshPage(candidate, origin)")
        val keep = exhausted.indexOf("ExhaustedRecoveryAction.KEEP_PAGE ->")
        val finish = exhausted.indexOf("finishConnectionAttempt()")
        assertTrue(probe >= 0)
        assertTrue(keep > probe)
        assertTrue("Keep the original deadline and cancellation until the mounted result is known", finish > keep)
        assertTrue(exhausted.substring(finish).contains("showLoadFailure(LoadFailure.NETWORK)"))
    }

    @Test fun cancellationAndTimeoutCopyExistsInEveryNativeLocale() {
        val keys = listOf("connection_cancel", "connection_stop_reconnecting", "connection_timed_out", "connection_cancelled", "reconnect_stopped")
        val translations = listOf("values", "values-zh-rCN", "values-it").map { locale ->
            val source = mainSource("res/$locale/strings.xml")
            keys.associateWith { key ->
                val values = Regex("<string\\s+name=\"$key\">([\\s\\S]*?)</string>").findAll(source).toList()
                assertTrue("$locale must declare exactly one $key", values.size == 1)
                values.single().groupValues[1].trim().also {
                    assertTrue("$locale/$key must not rely on empty fallback copy", it.isNotEmpty())
                }
            }
        }
        for (key in listOf("connection_cancel", "connection_stop_reconnecting")) {
            assertTrue("$key must be translated rather than repeated English", translations.map { it.getValue(key) }.toSet().size == 3)
        }
    }

    private fun method(source: String, name: String): String {
        val start = source.indexOf("private fun $name(")
        assertTrue("$name not found", start >= 0)
        val next = Regex("\\n    (?:private|internal|protected|override|public) ").find(source, start + 1)
        return source.substring(start, next?.range?.first ?: source.length)
    }

    private fun activitySource(): String = mainSource("java/io/github/sayach/dshmobile/MainActivity.kt")

    private fun mainSource(relative: String): String = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/$relative") } }
        .first { it.isFile }.readText()
}
