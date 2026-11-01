package io.github.sayach.dshmobile

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.Settings
import android.text.TextUtils
import android.text.InputType
import android.text.InputFilter
import android.text.method.PasswordTransformationMethod
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewDatabase
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

/** Native Android shell for one authenticated DSH HTTPS origin. */
class MainActivity : Activity() {
    private data class PendingDownload(
        val origin: String,
        val url: String,
        val userAgent: String?,
        val mimeType: String,
        val filename: String,
        val caCertificate: ByteArray?,
    ) {
        fun toBundle(): Bundle = Bundle().apply {
            putString(KEY_ORIGIN, origin)
            putString(KEY_URL, url)
            putString(KEY_USER_AGENT, userAgent)
            putString(KEY_MIME_TYPE, mimeType)
            putString(KEY_FILENAME, filename)
            putByteArray(KEY_CA_CERTIFICATE, caCertificate?.copyOf())
        }

        companion object {
            private const val KEY_ORIGIN = "origin"
            private const val KEY_URL = "url"
            private const val KEY_USER_AGENT = "user_agent"
            private const val KEY_MIME_TYPE = "mime_type"
            private const val KEY_FILENAME = "filename"
            private const val KEY_CA_CERTIFICATE = "ca_certificate"

            fun fromBundle(bundle: Bundle?): PendingDownload? {
                if (bundle == null) return null
                val origin = bundle.getString(KEY_ORIGIN) ?: return null
                val parsedOrigin = GatewayOrigin.parse(origin) ?: return null
                val url = bundle.getString(KEY_URL)?.takeIf { it.length in 1..8_192 } ?: return null
                if (!GatewayUrlPolicy.isAllowedDownload(parsedOrigin, url)) return null
                val mimeType = bundle.getString(KEY_MIME_TYPE)?.takeIf { it.length in 1..128 } ?: return null
                val filename = bundle.getString(KEY_FILENAME)?.takeIf { it.length in 1..128 } ?: return null
                val userAgent = bundle.getString(KEY_USER_AGENT)?.takeIf { it.length <= 1_024 }
                val certificate = bundle.getByteArray(KEY_CA_CERTIFICATE)
                if (certificate != null && certificate.size > 16 * 1024) return null
                return PendingDownload(origin, url, userAgent, mimeType, filename, certificate)
            }
        }
    }

    private data class DeferredBridgeResult(
        val requestCode: Int,
        val resultCode: Int,
        val data: Intent?,
    )

    private data class RetainedBridgeHandoff(
        val bridgeState: Bundle?,
        val deferredResult: DeferredBridgeResult?,
        val deferredPermission: IntArray?,
        val pendingDownload: PendingDownload?,
    )

    private data class StagedBrowser(val browser: WebView, val bridge: NativeBridge)

    private val preferences by lazy { getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE) }
    private val lanCredentialStore by lazy { DeviceCredentialStore(this, "lan") }
    private val remoteCredentialStore by lazy { DeviceCredentialStore(this, "remote") }
    private val pairedDeviceStore by lazy { PairedDeviceStore(this) }
    private var legacyStorageUnavailable = false
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val restoreExecutor = Executors.newFixedThreadPool(3)
    private val restoreWorkGate = NativeRestoreWorkGate<String>(restoreExecutor)
    // Reserve bounded probe capacity: two slow status jobs plus LAN renewal may occupy restoreExecutor.
    // The shared work gate still serializes physical operations for the same credential.
    private val sameHostProbeExecutor = java.util.concurrent.ThreadPoolExecutor(1, 1, 0L,
        java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue(1))
    private val connectionCancellationExecutor = Executors.newFixedThreadPool(2)
    private val irohController by lazy {
        IrohConnectionController(
            native = object : IrohTransportNative {
                override fun connect(requestId: Long, request: IrohConnectionRequest): String {
                    IrohNative.initialize(applicationContext)
                    return IrohNative.connect(requestId, request)
                }
                override fun close(requestId: Long) = IrohNative.close(requestId)
                override fun status(requestId: Long) = IrohNative.status(requestId)
            },
            worker = restoreExecutor,
            dispatch = { callback -> runOnUiThread(callback) },
            onCleanupFailure = { android.util.Log.w("DSHMobile", "iroh transport cleanup failed") },
        )
    }
    @Volatile private var activeIroh: IrohCarrierSession? = null
    private var irohRequestId: Long? = null
    private var irohCancellationRegistration: (() -> Unit)? = null
    private var activityResumed = false
    private class IrohCompatibilityFailure(val issue: CompatibilityIssue) : java.io.IOException("Unsupported mobile protocol")
    private val recoveryHandler = Handler(Looper.getMainLooper())
    private val restoreUiHandler = Handler(Looper.getMainLooper())
    private val connectionAttempts by lazy {
        ConnectionAttemptController(
            schedule = { delay, task ->
                restoreUiHandler.postDelayed(task, delay)
                val remove: () -> Unit = { restoreUiHandler.removeCallbacks(task) }
                remove
            },
            cancellationFactory = {
                NativeConnectionCancellation(
                    dispatchCancellation = { task -> connectionCancellationExecutor.execute(task) },
                    onCleanupFailure = { android.util.Log.w("DSHMobile", "Connection cleanup failed") },
                )
            },
        )
    }
    private var pendingConnection: ConnectionAttemptController.Attempt? = null
    private var connectionCancellationAction: ((ConnectionAttemptController.Reason) -> Unit)? = null
    private var connectionWaitingView: FrameLayout? = null
    private var connectionCancelButton: Button? = null
    private var connectionFullWaitingView: FrameLayout? = null
    private var connectionFullCancelButton: Button? = null
    private var connectionPageVisible = false
    private val waitingRootAccessibility = mutableMapOf<View, Int>()
    private val waitingRootFocusability = mutableMapOf<ViewGroup, Int>()
    private var pageReadyCheck: Runnable? = null
    private var loadingConnectionAttempt: ConnectionAttemptController.Attempt? = null
    private var loadingDocumentGeneration: Int? = null
    private var recoveryStoppedBrowser: WebView? = null
    private val deviceStatusHandler = Handler(Looper.getMainLooper())
    private val backUiHandler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var secureWebViewClient: SecureWebViewClient? = null
    private var nativeBridge: NativeBridge? = null
    private var restoredNativeBridgeState: Bundle? = null
    private var deferredBridgeResult: DeferredBridgeResult? = null
    private var deferredBridgePermission: IntArray? = null
    /** WebView microphone request held while its system permission dialog is open. */
    private data class PendingAudioPermission(
        val request: PermissionRequest,
        val owner: WebView,
        val origin: GatewayOrigin,
    )

    private var pendingAudioPermission: PendingAudioPermission? = null
    // WebView exposes grants, not reliable track-ended events. Refuse migration for this document.
    private var audioCaptureGrantedBrowser: WebView? = null
    private var gatewayOrigin: GatewayOrigin? = null
    private var accessMode = AccessMode.LAN
    private var setupBackAction: (() -> Unit)? = null
    private data class PendingWebFileChooser(
        val owner: WebFileChooserOwner<WebView>,
        val callback: ValueCallback<Array<Uri>>,
    )
    private val webFileChooser = WebFileChooserGate<PendingWebFileChooser>(webFileChooserRequestCodes)
    private var fileChooserDocument = 0L
    private var fileChooserNavigationListener: androidx.webkit.NavigationListener? = null
    private val fileChooserTransitions = WebFileChooserTransitions<androidx.webkit.Navigation>()
    private var pendingDownload: PendingDownload? = null
    private var failureDialog: AlertDialog? = null
    private var retryUrl: String? = null
    private var pendingScan: (() -> Unit)? = null
    private var nearbyPermissionLimited = false
    private var showingSetup = false
    private val restoreAttemptGate = RestoreAttemptGate()
    private val bridgeSessionRenewal = NativeSessionRenewalGate()
    private val restoreGeneration: Int get() = restoreAttemptGate.generation
    private val pairingAttemptGate = PairingAttemptGate()
    private val pairingGeneration: Int get() = pairingAttemptGate.generation
    private var connectionCenterStatus: TextView? = null
    private var recoveryAttempt = 0
    private val recoveryScheduled: Boolean get() = restoreAttemptGate.retryPending
    private val warnedTailscaleOrigins = mutableSetOf<String>()
    private val deviceStatusPoller by lazy {
        DeviceStatusPoller(
            executor = restoreExecutor,
            dispatch = { callback -> runOnUiThread(callback) },
            probe = ::probeSavedDevice,
            onResult = { device, result -> applyDeviceStatusResult(device, result) },
        )
    }
    private var deviceListRefreshRunnable: Runnable? = null
    private var activeDeviceKey: String? = null
    private val deviceStatusViews = mutableMapOf<String, TextView>()
    private var deviceListStatus: TextView? = null
    private var deviceUndoPopup: PopupWindow? = null
    private var deviceListVisible = false
    private var rendererCrashTimes: List<Long> = emptyList()
    private var backRequestGeneration = 0
    private var backRequestPending = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        savedInstanceState?.getInt(STATE_NEXT_FILE_CHOOSER_CODE)?.let(webFileChooserRequestCodes::restoreAtLeast)
        cleanupStaleDownloadFiles(cacheDir)
        configureEdgeToEdgeWindow(window)
        applyStatusBarIconContrast(window, getColor(R.color.app_background))
        nearbyPermissionLimited = preferences.getBoolean(PREFERENCE_NEARBY_PERMISSION_LIMITED, false)
        migrateLegacyDeviceSlots()
        val retainedHandoff = lastNonConfigurationInstance as? RetainedBridgeHandoff
        restoredNativeBridgeState = retainedHandoff?.bridgeState
            ?: savedInstanceState?.getBundle(STATE_NATIVE_BRIDGE)
        if (retainedHandoff != null) {
            deferredBridgeResult = retainedHandoff.deferredResult
            deferredBridgePermission = retainedHandoff.deferredPermission
            pendingDownload = retainedHandoff.pendingDownload
        } else {
            savedInstanceState?.getInt(STATE_DEFERRED_BRIDGE_REQUEST, -1)?.takeIf { it >= 0 }?.let { requestCode ->
                deferredBridgeResult = DeferredBridgeResult(
                    requestCode,
                    savedInstanceState.getInt(STATE_DEFERRED_BRIDGE_RESULT),
                    @Suppress("DEPRECATION") savedInstanceState.getParcelable(STATE_DEFERRED_BRIDGE_DATA),
                )
            }
            deferredBridgePermission = savedInstanceState?.getIntArray(STATE_DEFERRED_BRIDGE_PERMISSION)
            pendingDownload = PendingDownload.fromBundle(savedInstanceState?.getBundle(STATE_PENDING_DOWNLOAD))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            ) { handleBack() }
        }

        val restoredMode = AccessMode.parse(savedInstanceState?.getString(STATE_ACCESS_MODE))
        accessMode = restoredMode ?: AccessMode.LAN
        if (savedInstanceState?.getBoolean(STATE_SHOWING_SETUP) == true) {
            showConnectionCenter()
        } else {
            restoreColdStartConnection(
                restoredMode ?: AccessMode.parse(preferences.getString(PREFERENCE_LAST_ACCESS_MODE, null)),
            )
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt(STATE_NEXT_FILE_CHOOSER_CODE, webFileChooserRequestCodes.nextCode())
        outState.putBoolean(STATE_SHOWING_SETUP, showingSetup)
        outState.putString(STATE_ACCESS_MODE, accessMode.name)
        (nativeBridge?.saveState() ?: restoredNativeBridgeState)?.let { outState.putBundle(STATE_NATIVE_BRIDGE, it) }
        deferredBridgeResult?.let { result ->
            outState.putInt(STATE_DEFERRED_BRIDGE_REQUEST, result.requestCode)
            outState.putInt(STATE_DEFERRED_BRIDGE_RESULT, result.resultCode)
            outState.putParcelable(STATE_DEFERRED_BRIDGE_DATA, result.data)
        }
        deferredBridgePermission?.let { outState.putIntArray(STATE_DEFERRED_BRIDGE_PERMISSION, it) }
        pendingDownload?.let { outState.putBundle(STATE_PENDING_DOWNLOAD, it.toBundle()) }
        super.onSaveInstanceState(outState)
    }

    /** Resize the live document without discarding its draft attachments or navigation state. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val decor = window.decorView
        val ime = decor.rootWindowInsets?.let(::resolveWebViewImeInset) ?: 0
        nativeBridge?.updateKeyboardState(resolveNativeKeyboardState(ime, newConfig.keyboard))
        decor.requestApplyInsets()
        decor.requestLayout()
        webView?.invalidate()
    }

    override fun onRetainNonConfigurationInstance(): Any = RetainedBridgeHandoff(
        bridgeState = nativeBridge?.handoffForConfiguration() ?: restoredNativeBridgeState,
        deferredResult = deferredBridgeResult,
        deferredPermission = deferredBridgePermission?.copyOf(),
        pendingDownload = pendingDownload?.let { it.copy(caCertificate = it.caCertificate?.copyOf()) },
    )

    // minSdk 29 still needs the legacy dispatch: the predictive-back callback is
    // registered only on API 33+ (see onCreate). AGP 9 lint promotes the override
    // itself to an error, so the deliberate fallback is suppressed here.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Activity back dispatch remains a fallback when the platform callback is not delivered.")
    override fun onBackPressed() {
        handleBack()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (nativeBridge?.onActivityResult(requestCode, resultCode, data) == true) return
        if (NativeBridge.isBridgeRequestCode(requestCode)) {
            deferredBridgeResult = DeferredBridgeResult(requestCode, resultCode, data)
            return
        }
        if (WebFileChooserRequestCodes.owns(requestCode)) {
            finishFileSelection(requestCode, resultCode, data)
            return
        }
        when (requestCode) {
            DOWNLOAD_DESTINATION_REQUEST -> finishDownloadSelection(resultCode, data)
            SCAN_QR_REQUEST -> finishScanResult(resultCode, data)
        }
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
        sameHostGate.resume()
        sameHostMonitor.start()
        nativeBridge?.onHostResumed()
        webView?.onResume()
        window.decorView.requestApplyInsets()
        if (deviceListVisible && showingSetup) refreshDeviceStatuses(pairedDeviceStore.load())
        startIrohStatusMonitor()
    }

    override fun onPause() {
        activityResumed = false
        stopIrohStatusMonitor()
        draftTransfer?.abort()
        releaseCapturedDraft()
        sameHostMonitor.stop()
        sameHostGate.pause()
        sameHostProbeCancellation?.cancel()
        sameHostProbeCancellation = null
        if (sameHostRestoreAttempt != null && pendingConnection === sameHostRestoreAttempt) {
            withdrawConnectionAttempt()
            cancelAutomaticRecovery()
            invalidateRestoreAttempts()
        }
        sameHostRestoreAttempt = null
        sameHostConfirmation?.dismiss()
        pauseDeviceListRefresh()
        cancelPendingWebBack()
        nativeBridge?.updateKeyboardState(NativeKeyboardState(false, false))
        webView?.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        stopIrohTransport()
        irohController.close()
        withdrawConnectionAttempt()
        dismissDeviceUndo()
        stopDeviceListRefresh()
        cancelAutomaticRecovery()
        invalidateRestoreAttempts()
        invalidatePairingAttempts()
        failureDialog?.dismiss()
        retryUrl = null
        destroyWebView(isChangingConfigurations)
        if (!isChangingConfigurations) {
            restoredNativeBridgeState?.let { NativeBridge.disposeSavedState(this, it) }
            restoredNativeBridgeState = null
        }
        ioExecutor.shutdownNow()
        restoreExecutor.shutdownNow()
        sameHostProbeExecutor.shutdownNow()
        // A cancelled worker may register its final disconnect after Activity teardown.
        Thread({
            for (executor in listOf(ioExecutor, restoreExecutor, sameHostProbeExecutor)) {
                while (!executor.awaitTermination(1, java.util.concurrent.TimeUnit.DAYS)) Unit
            }
            connectionCancellationExecutor.shutdown()
        }, "dsh-mobile-connection-teardown").start()
        super.onDestroy()
    }

    private fun handleBack() {
        if (isFinishing || isDestroyed) return
        pendingConnection?.let {
            connectionAttempts.cancel(it)
            return
        }
        val browser = webView
        if (browser == null) {
            handleNativeBack(null)
            return
        }
        if (backRequestPending) return
        backRequestPending = true
        val generation = ++backRequestGeneration
        val url = browser.url
        val completed = AtomicBoolean(false)
        lateinit var timeout: Runnable
        val complete = { evaluation: MobileBackEvaluation ->
            if (completed.compareAndSet(false, true)) {
                backUiHandler.removeCallbacks(timeout)
                if (generation == backRequestGeneration) backRequestPending = false
                when (mobileBackAction(
                    generation,
                    backRequestGeneration,
                    webView === browser,
                    webView === browser && browser.url == url,
                    !isFinishing && !isDestroyed,
                    evaluation,
                )) {
                    MobileBackAction.NATIVE_BACK -> handleNativeBack(browser)
                    MobileBackAction.RETRY -> toast(R.string.back_page_unresponsive)
                    MobileBackAction.PAGE_HANDLED, MobileBackAction.IGNORE -> Unit
                }
            }
        }
        timeout = Runnable { complete(MobileBackEvaluation.UNAVAILABLE) }
        backUiHandler.postDelayed(timeout, MOBILE_BACK_TIMEOUT_MS)
        try {
            browser.evaluateJavascript(MOBILE_BACK_SCRIPT) { result -> complete(mobileBackEvaluation(result)) }
        } catch (error: RuntimeException) {
            complete(MobileBackEvaluation.UNAVAILABLE)
        }
    }

    private fun handleNativeBack(browser: WebView?) {
        if (browser?.canGoBack() == true) {
            cancelWebFileChooser()
            browser.goBack()
        } else if (setupBackAction != null) {
            setupBackAction?.invoke()
        } else {
            finish()
        }
    }

    private fun cancelPendingWebBack() {
        backRequestGeneration++
        backRequestPending = false
        backUiHandler.removeCallbacksAndMessages(null)
    }

    /** Convert the legacy one-LAN/one-remote stores into the encrypted device list once. */
    private fun migrateLegacyDeviceSlots(): Boolean = try {
        pairedDeviceStore.requireReadable()
        if (!pairedDeviceStore.isMigrationComplete()) {
            val slots = AccessMode.entries.map { mode -> LegacyDeviceSlot(
                mode = mode,
                origin = GatewayOrigin.parse(preferences.getString(originPreference(mode), "").orEmpty()),
                credential = credentialStore(mode).read(),
                displayName = localizedDefaultDeviceName(mode),
                lastConnectedAt = preferences.getLong(lastConnectedPreference(mode), 0L).takeIf { it > 0L },
            ) }
            migrateLegacyPairedDevices(pairedDeviceStore, slots, System.currentTimeMillis())
        }
        legacyStorageUnavailable = false
        true
    } catch (_: CredentialStorageUnavailable) {
        legacyStorageUnavailable = true
        false
    } catch (_: ClassCastException) {
        legacyStorageUnavailable = true
        false
    }

    private fun showCredentialStorageFailure() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            runOnUiThread { if (!isFinishing && !isDestroyed) showCredentialStorageFailure() }
            return
        }
        toastError(R.string.device_storage_unavailable)
        (deviceListStatus ?: connectionCenterStatus)?.apply {
            setText(R.string.device_storage_unavailable)
            visibility = View.VISIBLE
        }
    }

    private fun <T> withCredentialStorage(block: () -> T): T? = try { block() } catch (_: CredentialStorageUnavailable) {
        showCredentialStorageFailure()
        null
    }

    private fun prepareCredentialStorage(): Boolean {
        if (migrateLegacyDeviceSlots()) return true
        showCredentialStorageFailure()
        return false
    }

    private fun lastConnectedPreference(mode: AccessMode): String = when (mode) {
        AccessMode.LAN -> PREFERENCE_LAST_CONNECTED_LAN
        AccessMode.REMOTE -> PREFERENCE_LAST_CONNECTED_REMOTE
    }

    private fun localizedDefaultDeviceName(mode: AccessMode): String = when (mode) {
        AccessMode.LAN -> getString(R.string.default_lan_device_name)
        AccessMode.REMOTE -> getString(R.string.default_remote_device_name)
    }

    private fun PairedDeviceRecord.credential(): DeviceCredential = DeviceCredential(
        instanceId = instanceId,
        deviceToken = deviceToken,
        expiresAt = expiresAt,
        caCertificate = caCertificate,
    )

    private fun launchBehavior(): LaunchBehavior =
        LaunchBehavior.parse(preferences.getString(PREFERENCE_LAUNCH_BEHAVIOR, null)) ?: LaunchBehavior.DIRECT_DSH

    private fun credentialStore(mode: AccessMode = accessMode): DeviceCredentialStore = when (mode) {
        AccessMode.LAN -> lanCredentialStore
        AccessMode.REMOTE -> remoteCredentialStore
    }

    private fun legacyCredentialForRestore(mode: AccessMode = accessMode): DeviceCredential? =
        when (val current = readLegacyCredentialForRestore(pairedDeviceStore) { credentialStore(mode).read() }) {
            CredentialRead.Absent -> null
            CredentialRead.Unreadable -> { legacyStorageUnavailable = true; null }
            is CredentialRead.Loaded -> current.value
        }

    private fun originPreference(mode: AccessMode = accessMode): String = when (mode) {
        AccessMode.LAN -> PREFERENCE_LAN_ORIGIN
        AccessMode.REMOTE -> PREFERENCE_REMOTE_ORIGIN
    }

    /** Own the complete user wait, including queued work, retries, cookies and initial page boot. */
    private fun startConnectionAttempt(
        mode: AccessMode,
        message: CharSequence = getString(R.string.restoring_trust),
        preserveBrowser: WebView? = null,
        keepVisibleDocument: Boolean = false,
        onCancelled: (ConnectionAttemptController.Reason) -> Unit = { showConnectionCenter() },
    ): ConnectionAttemptController.Attempt {
        withdrawConnectionAttempt()
        connectionCancellationAction = onCancelled
        val attempt = connectionAttempts.start(
            if (mode == AccessMode.LAN) LAN_CONNECTION_BUDGET_MS else REMOTE_CONNECTION_BUDGET_MS,
        ) { reason ->
            val returnToOwner = connectionCancellationAction
            connectionCancellationAction = null
            pendingConnection = null
            dismissConnectionProgress()
            cancelAutomaticRecovery()
            invalidateRestoreAttempts(if (reason == ConnectionAttemptController.Reason.TIMED_OUT) "timeout" else "cancelled")
            invalidatePairingAttempts()
            scanCanceled.set(true)
            if (preserveBrowser != null && webView === preserveBrowser) recoveryStoppedBrowser = preserveBrowser
            if (!isFinishing && !isDestroyed) {
                if (preserveBrowser == null || webView !== preserveBrowser) returnToOwner?.invoke(reason)
                else {
                    failureDialog?.dismiss()
                    returnFromStoppedRecoveryIfPageLost(preserveBrowser)
                }
                toastError(when {
                    reason == ConnectionAttemptController.Reason.TIMED_OUT -> R.string.connection_timed_out
                    preserveBrowser != null -> R.string.reconnect_stopped
                    else -> R.string.connection_cancelled
                })
            }
        }
        pendingConnection = attempt
        failureDialog?.dismiss()
        if (keepVisibleDocument && preserveBrowser != null) {
            showCompactConnectionWaiting(attempt, stopReconnecting = true)
            return attempt
        }
        currentFocus?.let { focused ->
            getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(focused.windowToken, 0)
        }
        val waiting = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.app_background))
            isClickable = true
            isFocusableInTouchMode = true
            accessibilityPaneTitle = message
            // Receive unconsumed Insets before the real page while still drawing above it.
            translationZ = dp(1).toFloat()
        }
        addSetupArtwork(waiting)
        for (index in 0 until waiting.childCount) waiting.getChildAt(index).importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(ProgressBar(this@MainActivity).apply {
                indeterminateTintList = ColorStateList.valueOf(getColor(R.color.app_accent))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(dp(48), dp(48)))
            addView(spacer(16))
            addView(TextView(this@MainActivity).apply {
                text = message
                textSize = 16f
                gravity = Gravity.CENTER
                setTextColor(getColor(R.color.app_secondary))
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(spacer(24))
            val cancel = secondaryButton(
                if (preserveBrowser == null) R.string.connection_cancel else R.string.connection_stop_reconnecting,
                48,
            ) { connectionAttempts.cancel(attempt) }
            connectionCancelButton = cancel
            addView(cancel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        scroll.addView(content, FrameLayout.LayoutParams(
            min((resources.displayMetrics.widthPixels - dp(64)).coerceAtLeast(1), dp(400)),
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER_HORIZONTAL,
        ))
        scroll.addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
            val width = (right - left - scroll.paddingLeft - scroll.paddingRight).coerceIn(1, dp(400))
            if (content.layoutParams.width != width) content.layoutParams = content.layoutParams.apply { this.width = width }
        }
        waiting.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        waiting.setOnApplyWindowInsetsListener { _, insets ->
            val edges = resolveWebViewSafeArea(insets)
            scroll.setPadding(dp(32) + edges.left, dp(32) + edges.top, dp(32) + edges.right, dp(32) + edges.bottom)
            insets
        }
        connectionWaitingView = waiting
        connectionFullWaitingView = waiting
        connectionFullCancelButton = connectionCancelButton
        applyStatusBarIconContrast(window, getColor(R.color.app_background))
        attachConnectionWaitingView()
        return attempt
    }

    /** Only presentation is detached when the real form/browser root changes. */
    private fun detachConnectionWaitingView() {
        connectionWaitingView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        for ((root, previous) in waitingRootAccessibility) root.importantForAccessibility = previous
        waitingRootAccessibility.clear()
        for ((root, previous) in waitingRootFocusability) root.descendantFocusability = previous
        waitingRootFocusability.clear()
    }

    private fun attachConnectionWaitingView() {
        val waiting = connectionWaitingView ?: return
        val attempt = pendingConnection ?: return
        if (!connectionAttempts.isCurrent(attempt)) return
        detachConnectionWaitingView()
        val container = findViewById<FrameLayout>(android.R.id.content)
        if (!connectionPageVisible) {
            for (index in 0 until container.childCount) {
                val root = container.getChildAt(index)
                waitingRootAccessibility[root] = root.importantForAccessibility
                root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                if (root is ViewGroup) {
                    waitingRootFocusability[root] = root.descendantFocusability
                    root.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
                }
            }
        }
        container.addView(waiting, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (!connectionPageVisible) waiting.requestFocus()
        window.decorView.rootWindowInsets?.let { waiting.dispatchApplyWindowInsets(it) }
        container.requestApplyInsets()
    }

    /** A committed page renders its own progress; native cancellation remains until it is usable. */
    private fun revealConnectionPage(browser: WebView, attempt: ConnectionAttemptController.Attempt, generation: Int) {
        if (connectionPageVisible || loadingConnectionAttempt !== attempt || !connectionAttempts.isCurrent(attempt)
            || loadingDocumentGeneration != generation || secureWebViewClient?.currentDocumentGeneration != generation
            || webView !== browser || isFinishing || isDestroyed) return
        showCompactConnectionWaiting(attempt)
    }

    /** A visible page retains input focus; only the native cancellation control overlays its content. */
    private fun showCompactConnectionWaiting(attempt: ConnectionAttemptController.Attempt, stopReconnecting: Boolean = false) {
        if (pendingConnection !== attempt || !connectionAttempts.isCurrent(attempt)) return
        detachConnectionWaitingView()
        val cancel = secondaryButton(
            if (stopReconnecting) R.string.connection_stop_reconnecting else R.string.connection_cancel,
            48,
        ) { connectionAttempts.cancel(attempt) }
        val compact = FrameLayout(this).apply {
            isClickable = false
            isFocusable = false
            translationZ = dp(1).toFloat()
            addView(cancel, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END,
            ))
            setOnApplyWindowInsetsListener { _, insets ->
                val edges = resolveWebViewSafeArea(insets)
                val layout = cancel.layoutParams as FrameLayout.LayoutParams
                if (layout.leftMargin != dp(16) + edges.left || layout.topMargin != dp(16) + edges.top
                    || layout.rightMargin != dp(16) + edges.right || layout.bottomMargin != dp(16) + edges.bottom) {
                    layout.leftMargin = dp(16) + edges.left
                    layout.topMargin = dp(16) + edges.top
                    layout.rightMargin = dp(16) + edges.right
                    layout.bottomMargin = dp(16) + edges.bottom
                    cancel.layoutParams = layout
                }
                insets
            }
        }
        connectionPageVisible = true
        connectionWaitingView = compact
        connectionCancelButton = cancel
        attachConnectionWaitingView()
        applyStatusBarIconContrast(window, preferences.getInt(PREFERENCE_WEB_CHROME_COLOR, getColor(R.color.app_background)))
    }

    /** A replacement document cannot inherit the outgoing document's visible-commit confirmation. */
    private fun restoreConnectionWaitingScreen() {
        if (!connectionPageVisible) return
        detachConnectionWaitingView()
        connectionPageVisible = false
        connectionWaitingView = connectionFullWaitingView
        connectionCancelButton = connectionFullCancelButton
        attachConnectionWaitingView()
        applyStatusBarIconContrast(window, getColor(R.color.app_background))
    }

    private fun setPageContent(root: View) {
        detachConnectionWaitingView()
        setContentView(root)
        attachConnectionWaitingView()
    }

    private fun dismissConnectionProgress() {
        loadingConnectionAttempt = null
        loadingDocumentGeneration = null
        pageReadyCheck?.let(restoreUiHandler::removeCallbacks)
        pageReadyCheck = null
        detachConnectionWaitingView()
        connectionWaitingView = null
        connectionCancelButton = null
        connectionFullWaitingView = null
        connectionFullCancelButton = null
        connectionPageVisible = false
        applyStatusBarIconContrast(window, if (webView == null) getColor(R.color.app_background)
            else preferences.getInt(PREFERENCE_WEB_CHROME_COLOR, getColor(R.color.app_background)))
    }

    private fun finishConnectionAttempt(attempt: ConnectionAttemptController.Attempt? = pendingConnection) {
        if (attempt != null && connectionAttempts.finish(attempt)) {
            restoreAttemptGate.completeRestore(restoreGeneration)
            pendingConnection = null
            connectionCancellationAction = null
            dismissConnectionProgress()
        }
    }

    private fun withdrawConnectionAttempt() {
        bridgeSessionRenewal.cancel()
        connectionAttempts.withdraw()
        pendingConnection = null
        connectionCancellationAction = null
        dismissConnectionProgress()
    }

    /** A stopped recovery keeps usable content, not a blank/error document with no controls. */
    private fun returnFromStoppedRecoveryIfPageLost(browser: WebView) {
        val origin = gatewayOrigin ?: return
        val generation = restoreGeneration
        val documentGeneration = secureWebViewClient?.currentDocumentGeneration ?: return
        val url = browser.url
        probeMountedDshPage(browser, origin, INITIAL_DSH_READY_PROBE) { mounted ->
            if (!mounted && !isFinishing && !isDestroyed && pendingConnection == null
                && restoreGeneration == generation && webView === browser && browser.url == url
                && secureWebViewClient?.currentDocumentGeneration == documentGeneration
                && gatewayOrigin == origin && recoveryStoppedBrowser === browser
            ) showConnectionCenter()
        }
    }

    private fun restoreColdStartConnection(preferredMode: AccessMode?) {
        val devices = pairedDeviceStore.load()
        if (legacyStorageUnavailable || pairedDeviceStore.storageUnavailable) {
            showConnectionCenter()
            showCredentialStorageFailure()
            return
        }
        if (devices.isEmpty() || launchBehavior() == LaunchBehavior.DEVICE_LIST) {
            showConnectionCenter()
            return
        }
        val preferred = ConnectionRestorePolicy.selectStartupDevice(
            devices = devices,
            savedKey = preferences.getString(PREFERENCE_LAST_DEVICE_KEY, null),
            preferredMode = preferredMode,
            now = System.currentTimeMillis(),
        )
        if (preferred == null) {
            showDeviceList()
            return
        }
        val startup = if (automaticSameHost()) SameHostSwitchPolicy.candidate(preferred, devices,
            if (sameHostMonitor.hasWifi()) AccessMode.LAN else AccessMode.REMOTE, System.currentTimeMillis()) ?: preferred else preferred
        activeDeviceKey = startup.key
        restoreStartupDevice(startup)
    }

    private fun restoreStartupDevice(device: PairedDeviceRecord) {
        // Direct startup should not flash the device list. Keep a small native
        // loading surface while the most recently used device is renewed.
        showRestoringTrust()
        activeDeviceKey = device.key
        restoreTrustedDevice(
            preferredOrigin = device.origin,
            credential = device.credential(),
            mode = device.mode,
            generation = beginRestoreAttempt(),
            deviceKey = device.key,
        ) { disposition ->
            if (trySameHostFallback(device, disposition) { showDeviceList() }) return@restoreTrustedDevice
            if (disposition == RestoreFailureDisposition.RETRY_TRANSIENT) {
                if (!scheduleAutomaticRecovery() && !isFinishing && !isDestroyed) {
                    showDeviceList()
                    deviceListStatus?.setText(R.string.background_restore_failed)
                }
            } else if (!isFinishing && !isDestroyed) {
                showDeviceList()
                deviceListStatus?.setText(R.string.background_restore_failed)
            }
        }
    }

    private fun showConnectionCenter() {
        if (pairedDeviceStore.load().isNotEmpty()) {
            showDeviceList()
            return
        }
        showConnectionChoices()
    }

    /** Render the stable device-management root used when more than one computer is paired. */
    private fun showDeviceList() {
        withdrawConnectionAttempt()
        stopDeviceListRefresh()
        invalidateRestoreAttempts()
        invalidatePairingAttempts()
        showingSetup = true
        setupBackAction = null
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        cancelAutomaticRecovery()
        failureDialog?.dismiss()
        deviceListVisible = true
        deviceStatusViews.clear()

        val card = createSetupCard(surface = false)
        val heading = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        heading.addView(textView(R.string.paired_devices_title, 30f, Typeface.BOLD), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        heading.addView(toolbarIconButton(R.drawable.ic_settings, R.string.device_list_settings).apply {
            setOnClickListener { showDeviceListSettings() }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        card.addView(heading)
        card.addView(spacer(8))
        deviceListStatus = textView(R.string.paired_devices_description, 16f, Typeface.NORMAL, R.color.app_secondary).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        card.addView(deviceListStatus)
        card.addView(spacer(18))
        val rows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val devices = pairedDeviceStore.load()
        devices.forEachIndexed { index, device ->
            if (index > 0) rows.addView(spacer(10))
            rows.addView(deviceRow(device))
        }
        card.addView(rows)
        card.addView(spacer(18))
        card.addView(primaryButton(R.string.add_computer, 52) { showConnectionChoices() }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        refreshDeviceStatuses(devices)
    }

    private fun deviceRow(device: PairedDeviceRecord): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(8), dp(12))
            background = roundedRipple(getColor(R.color.app_surface), 16)
            isClickable = true
            isFocusable = true
            contentDescription = getString(R.string.open_paired_device, device.displayName)
        }
        val details = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = TextView(this).apply {
            text = device.displayName
            textSize = 17f
            setTypeface(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(getColor(R.color.app_foreground))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        val address = TextView(this).apply {
            text = getString(R.string.paired_device_address, device.modeLabel(), device.origin.serialized)
            textSize = 12f
            setTextColor(getColor(R.color.app_secondary))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MIDDLE
        }
        val status = TextView(this).apply {
            textSize = 12f
            setTextColor(getColor(R.color.app_secondary))
            deviceStatusViews[device.key] = this
            setDeviceStatusText(this, device)
        }
        details.addView(title)
        details.addView(spacer(3))
        details.addView(address)
        details.addView(status)
        row.addView(details, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        updateDeviceRowAccessibility(row, device, status.text)
        row.addView(toolbarIconButton(R.drawable.ic_more_vertical, R.string.device_actions).apply {
            setOnClickListener { showDeviceActions(device) }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        row.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_chevron_right)
            contentDescription = null
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(32), dp(48)))
        row.setOnClickListener { connectPairedDevice(device) }
        row.setOnLongClickListener {
            row.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            showDeviceActions(device)
            true
        }
        return row
    }

    private fun PairedDeviceRecord.modeLabel(): String = if (iroh != null) getString(R.string.connection_mode_iroh) else when (mode) {
        AccessMode.LAN -> getString(R.string.connection_mode_lan)
        AccessMode.REMOTE -> getString(R.string.connection_mode_remote)
    }

    private fun setDeviceStatusText(view: TextView, device: PairedDeviceRecord) {
        val current = device.key == activeDeviceKey && webView != null
        val statusResource = when {
            current -> R.string.device_status_current
            device.iroh != null && !hasIrohTransport(device.iroh) && device.status != PairedDeviceStatus.REVOKED
                && device.status != PairedDeviceStatus.EXPIRED && device.status != PairedDeviceStatus.ADDRESS_CHANGED -> R.string.iroh_status_connect_to_check
            device.status == PairedDeviceStatus.REACHABLE -> R.string.device_status_reachable
            device.status == PairedDeviceStatus.REVOKED -> R.string.device_status_revoked
            device.status == PairedDeviceStatus.EXPIRED -> R.string.device_status_expired
            device.status == PairedDeviceStatus.ADDRESS_CHANGED -> R.string.device_status_address_changed
            device.status == PairedDeviceStatus.UNREACHABLE -> R.string.device_status_unreachable
            else -> R.string.device_status_checking
        }
        val status = getString(statusResource)
        view.text = if (device.lastConnectedAt != null || device.status != PairedDeviceStatus.UNKNOWN) {
            getString(R.string.device_status_summary, status, formatLastConnected(device.lastConnectedAt))
        } else {
            status
        }
        val color = getColor(if (current || (device.status == PairedDeviceStatus.REACHABLE && device.iroh == null)) R.color.app_success else R.color.app_secondary)
        view.setTextColor(color)
        view.setCompoundDrawablesWithIntrinsicBounds(
            GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(color)
                setSize(dp(8), dp(8))
            },
            null,
            null,
            null,
        )
        view.compoundDrawablePadding = dp(6)
        updateDeviceRowAccessibility(view.parent?.parent as? View, device, view.text)
    }

    private fun formatLastConnected(timestamp: Long?): String {
        if (timestamp == null) return getString(R.string.device_last_connected_never)
        val elapsed = (System.currentTimeMillis() - timestamp).coerceAtLeast(0L)
        return when {
            elapsed < 60_000L -> getString(R.string.device_last_connected_now)
            elapsed < 3_600_000L -> getString(R.string.device_last_connected_minutes, (elapsed / 60_000L).coerceAtLeast(1L))
            elapsed < 86_400_000L -> getString(R.string.device_last_connected_hours, (elapsed / 3_600_000L).coerceAtLeast(1L))
            elapsed < 7 * 86_400_000L -> getString(R.string.device_last_connected_days, (elapsed / 86_400_000L).coerceAtLeast(1L))
            else -> DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(timestamp))
        }
    }

    private fun updateDeviceRowAccessibility(row: View?, device: PairedDeviceRecord, status: CharSequence) {
        row?.contentDescription = getString(
            R.string.paired_device_accessibility,
            device.displayName,
            device.modeLabel(),
            device.origin.serialized,
            status,
        )
    }

    private fun refreshDeviceStatuses(devices: List<PairedDeviceRecord>) {
        deviceListRefreshRunnable?.let(deviceStatusHandler::removeCallbacks)
        // Listing computers must not silently open a tunnel to every paired iroh host.
        deviceStatusPoller.refresh(devices.filter { it.iroh == null })
        if (devices.none { it.iroh == null }) { deviceListRefreshRunnable = null; return }
        deviceListRefreshRunnable = Runnable {
            if (!isFinishing && !isDestroyed && deviceListVisible && showingSetup && pairedDeviceStore.load().isNotEmpty()) refreshDeviceStatuses(pairedDeviceStore.load())
        }.also { deviceStatusHandler.postDelayed(it, DEVICE_STATUS_REFRESH_MS) }
    }

    private fun applyDeviceStatusResult(device: PairedDeviceRecord, result: Result<NativeProbe>) {
        if (!deviceListVisible || !showingSetup || isFinishing || isDestroyed) return
        val updated = withCredentialStorage { pairedDeviceStore.update(device.key) { current ->
            PairedDeviceStatusPolicy.applyProbe(
                current, device, result.getOrNull(),
                (result.exceptionOrNull() as? NativeAuthFailure)?.kind, System.currentTimeMillis(),
            )
        } }
        updated?.let { setDeviceStatusText(deviceStatusViews[device.key] ?: return@let, it) }
    }

    private fun stopDeviceListRefresh() {
        deviceStatusPoller.stop()
        deviceListRefreshRunnable?.let(deviceStatusHandler::removeCallbacks)
        deviceListRefreshRunnable = null
        deviceStatusViews.clear()
    }

    private fun pauseDeviceListRefresh() {
        deviceStatusPoller.stop()
        deviceListRefreshRunnable?.let(deviceStatusHandler::removeCallbacks)
        deviceListRefreshRunnable = null
    }

    private fun showDeviceActions(snapshot: PairedDeviceRecord) {
        if (!prepareCredentialStorage()) return
        val devices = pairedDeviceStore.load()
        val device = devices.firstOrNull { it.key == snapshot.key } ?: return
        val needsRepair = device.status == PairedDeviceStatus.REVOKED
            || device.status == PairedDeviceStatus.EXPIRED
            || device.status == PairedDeviceStatus.ADDRESS_CHANGED
        // The list keeps a fixed order, so these two actions are the only way to arrange it. They
        // appear only where they change something: the first row can neither move up nor go to the
        // top, and the second row has nothing left to jump over.
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        actions.add(getString(if (needsRepair) R.string.device_action_repair else R.string.device_action_connect) to {
            if (needsRepair) repairPairedDevice(device) else connectPairedDevice(device)
        })
        actions.add(getString(R.string.device_action_edit) to { editDeviceName(device) })
        if (device.iroh == null) actions.add(getString(R.string.device_action_check) to check@ {
            if (withCredentialStorage { pairedDeviceStore.update(device.key, PairedDeviceStatusPolicy::beginCheck) } == null) return@check
            showDeviceList()
        })
        if (PairedDeviceOrderPolicy.canMoveUp(devices, device.key)) {
            actions.add(getString(R.string.device_action_move_up) to move@ {
                if (withCredentialStorage { pairedDeviceStore.moveUp(device.key) } != true) return@move
                showDeviceList()
            })
        }
        if (PairedDeviceOrderPolicy.canMoveToTop(devices, device.key)) {
            actions.add(getString(R.string.device_action_move_top) to move@ {
                if (withCredentialStorage { pairedDeviceStore.moveToTop(device.key) } != true) return@move
                showDeviceList()
            })
        }
        actions.add(getString(R.string.device_action_delete) to { confirmDeleteDevice(device) })
        AlertDialog.Builder(this)
            .setTitle(device.displayName)
            .setItems(actions.map { it.first }.toTypedArray()) { _, which -> actions[which].second() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun repairPairedDevice(device: PairedDeviceRecord) {
        activeDeviceKey = null
        accessMode = device.mode
        if (device.iroh != null) showIrohSetup() else if (device.mode == AccessMode.LAN) showSetup() else showRemoteSetup()
    }

    private fun editDeviceName(device: PairedDeviceRecord) {
        val input = EditText(this).apply {
            setText(device.displayName)
            setSelection(text.length)
            hint = getString(R.string.device_name_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minHeight = dp(48)
            setPadding(dp(12), 0, dp(12), 0)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.edit_device_name)
            .setView(input)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.save) { _, _ ->
                val name = java.text.Normalizer.normalize(input.text.toString(), java.text.Normalizer.Form.NFC).trim()
                if (name.length !in 1..32 || Regex("[\\u0000-\\u001f\\u007f]").containsMatchIn(name)) {
                    Toast.makeText(this, R.string.invalid_device_name, Toast.LENGTH_SHORT).show()
                } else {
                    if (withCredentialStorage { pairedDeviceStore.update(device.key) { it.copy(displayName = name) } } == null) return@setPositiveButton
                    showDeviceList()
                }
            }
            .show()
    }

    private fun confirmDeleteDevice(device: PairedDeviceRecord) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.delete_device_title, device.displayName))
            .setMessage(R.string.delete_device_message)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ ->
                if (!prepareCredentialStorage()) return@setPositiveButton
                val legacyCredential = credentialStore(device.mode).load()
                    ?.takeIf { it.instanceId == device.instanceId }
                val legacyOrigin = preferences.getString(originPreference(device.mode), null)
                if (withCredentialStorage { pairedDeviceStore.remove(device.key) } != true) return@setPositiveButton
                if (activeDeviceKey == device.key) {
                    stopIrohTransport()
                    activeDeviceKey = null
                    destroyWebView()
                }
                val legacyCleared = legacyCredential == null || withCredentialStorage { credentialStore(device.mode).clear() } != null
                if (legacyCredential != null && legacyOrigin == device.origin.serialized) {
                    preferences.edit().remove(originPreference(device.mode)).apply()
                }
                showConnectionCenter()
                showDeviceUndo(device, legacyCredential, legacyOrigin)
                if (!legacyCleared) showCredentialStorageFailure()
            }
            .show()
    }

    private fun showDeviceUndo(
        record: PairedDeviceRecord,
        legacyCredential: DeviceCredential?,
        legacyOrigin: String?,
    ) {
        dismissDeviceUndo()
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(8), dp(8), dp(8))
            background = roundedSurface(getColor(R.color.app_surface), 16).apply {
                setStroke(dp(1), getColor(R.color.app_border))
            }
        }
        content.addView(
            TextView(this).apply {
                text = getString(R.string.device_deleted, record.displayName)
                textSize = 14f
                setTextColor(getColor(R.color.app_foreground))
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        val popup = PopupWindow(
            content,
            min(resources.displayMetrics.widthPixels - dp(32), dp(560)),
            ViewGroup.LayoutParams.WRAP_CONTENT,
            false,
        ).apply {
            isOutsideTouchable = true
            elevation = dp(8).toFloat()
            setBackgroundDrawable(roundedSurface(getColor(R.color.app_surface), 16))
        }
        content.addView(Button(this).apply {
            setText(R.string.undo)
            isAllCaps = false
            minHeight = dp(48)
            setTextColor(getColor(R.color.app_accent))
            backgroundTintList = null
            background = roundedRipple(getColor(R.color.app_surface), 12)
            setOnClickListener {
                if (withCredentialStorage { pairedDeviceStore.upsert(record) } == null) return@setOnClickListener
                if (legacyCredential != null && withCredentialStorage {
                        if (!pairedDeviceStore.isMigrationComplete()) credentialStore(record.mode).save(legacyCredential)
                    } == null) return@setOnClickListener
                if (legacyCredential != null && legacyOrigin != null) {
                    preferences.edit().putString(originPreference(record.mode), legacyOrigin).apply()
                }
                popup.dismiss()
                deviceUndoPopup = null
                showDeviceList()
                deviceListStatus?.setText(R.string.device_undo_done)
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        popup.setOnDismissListener {
            if (deviceUndoPopup === popup) deviceUndoPopup = null
        }
        deviceUndoPopup = popup
        popup.showAtLocation(window.decorView, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL, 0, dp(24))
        recoveryHandler.postDelayed({
            if (deviceUndoPopup === popup) popup.dismiss()
        }, DEVICE_UNDO_TIMEOUT_MS)
    }

    private fun dismissDeviceUndo() {
        deviceUndoPopup?.dismiss()
        deviceUndoPopup = null
    }

    private fun showDeviceListSettings() {
        AlertDialog.Builder(this)
            .setTitle(R.string.device_list_settings)
            .setItems(arrayOf(getString(R.string.launch_settings), getString(R.string.icon_settings), getString(R.string.same_host_title))) { _, which ->
                when (which) { 0 -> showLaunchSettings(); 1 -> showIconSettings(); else -> showSameHostSettings() }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showLaunchSettings() {
        val values = arrayOf(getString(R.string.launch_direct_dsh), getString(R.string.launch_device_list))
        val selected = if (launchBehavior() == LaunchBehavior.DEVICE_LIST) 1 else 0
        AlertDialog.Builder(this)
            .setTitle(R.string.launch_settings)
            .setSingleChoiceItems(values, selected) { dialog, which ->
                preferences.edit().putString(PREFERENCE_LAUNCH_BEHAVIOR, if (which == 1) LaunchBehavior.DEVICE_LIST.name else LaunchBehavior.DIRECT_DSH.name).apply()
                dialog.dismiss()
                deviceListStatus?.setText(R.string.launch_setting_saved)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Flip the launcher icon between the DSH whale mascot and the official whale marks. */
    private fun iconComponent(icon: LauncherIconPolicy.Icon): ComponentName = ComponentName(
        packageName,
        LauncherIconPolicy.aliasClassName(MainActivity::class.java.name.substringBeforeLast('.'), icon),
    )

    private fun currentAppIcon(): String = LauncherIconPolicy.selectedKey(
        preferences.getString(PREFERENCE_APP_ICON, null),
    ) { packageManager.getComponentEnabledSetting(iconComponent(it)) }

    private fun applyAppIcon(icon: String) {
        val pm = packageManager
        try {
            LauncherIconPolicy.switchIcon(
                key = icon,
                atomic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU,
                readState = { pm.getComponentEnabledSetting(iconComponent(it)) },
            ) { changes ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    pm.setComponentEnabledSettings(changes.map {
                        PackageManager.ComponentEnabledSetting(iconComponent(it.icon), it.state, PackageManager.DONT_KILL_APP)
                    })
                } else {
                    changes.forEach {
                        pm.setComponentEnabledSetting(iconComponent(it.icon), it.state, PackageManager.DONT_KILL_APP)
                    }
                }
            }
            preferences.edit().putString(PREFERENCE_APP_ICON, icon).apply()
            deviceListStatus?.setText(R.string.icon_settings_saved)
        } catch (error: Exception) {
            // Package-manager failure is reported without persisting an unconfirmed selection.
            Toast.makeText(this, R.string.icon_settings_failed, Toast.LENGTH_LONG).show()
        }
    }

    private fun showIconSettings() {
        val keys = LauncherIconPolicy.icons.map { it.key }
        val labels = arrayOf(
            getString(R.string.icon_choice_whale_girl),
            getString(R.string.icon_choice_official_whale),
            getString(R.string.icon_choice_official_whale_dark),
            getString(R.string.icon_choice_official_whale_teal),
            getString(R.string.icon_choice_official_whale_mono),
            getString(R.string.icon_choice_official_whale_black),
            getString(R.string.icon_choice_official_whale_white),
        )
        val selected = keys.indexOf(currentAppIcon()).coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(R.string.icon_settings)
            .setSingleChoiceItems(labels, selected) { dialog, which ->
                dialog.dismiss()
                applyAppIcon(keys[which])
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }
    private fun connectPairedDevice(snapshot: PairedDeviceRecord) {
        if (!prepareCredentialStorage()) return
        val device = pairedDeviceStore.load().firstOrNull { it.key == snapshot.key } ?: return
        if (device.iroh == null) stopIrohTransport()
        if (device.status == PairedDeviceStatus.REVOKED
            || device.status == PairedDeviceStatus.EXPIRED
            || device.status == PairedDeviceStatus.ADDRESS_CHANGED
        ) {
            showDeviceActions(device)
            return
        }
        withdrawConnectionAttempt()
        cancelAutomaticRecovery()
        invalidatePairingAttempts()
        activeDeviceKey = device.key
        accessMode = device.mode
        (deviceListStatus ?: connectionCenterStatus)?.apply {
            text = getString(R.string.connecting_to_device, device.displayName)
            visibility = View.VISIBLE
        }
        restoreTrustedDevice(device.origin, device.credential(), device.mode, beginRestoreAttempt(), deviceKey = device.key) { _ ->
            // Explicit selection always settles; retryable failures are not an active retry.
            showDeviceList()
            deviceListStatus?.apply {
                setText(R.string.connection_failed)
                visibility = View.VISIBLE
            }
        }
    }

    private fun showConnectionChoices() {
        stopIrohTransport()
        withdrawConnectionAttempt()
        stopDeviceListRefresh()
        deviceListVisible = false
        invalidateRestoreAttempts()
        invalidatePairingAttempts()
        showingSetup = true
        setupBackAction = null
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        cancelAutomaticRecovery()
        failureDialog?.dismiss()

        val card = createSetupCard(surface = false)
        card.addView(textView(R.string.connection_center_title, 30f, Typeface.BOLD))
        card.addView(spacer(8))
        card.addView(textView(R.string.connection_center_description, 16f, Typeface.NORMAL, R.color.app_secondary))
        val restoreStatus = textView(
            R.string.background_restore_running,
            14f,
            Typeface.NORMAL,
            R.color.app_secondary,
        ).apply {
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            setPadding(0, dp(12), 0, 0)
        }
        connectionCenterStatus = restoreStatus
        card.addView(restoreStatus)
        card.addView(spacer(24))
        card.addView(accessChoice(
            R.string.lan_access_title,
            R.string.lan_access_description,
            legacyCredentialForRestore(AccessMode.LAN)?.expiresAt?.let { it > System.currentTimeMillis() } == true,
            action = { openAccessMode(AccessMode.LAN, restoreSaved = pairedDeviceStore.load().isEmpty()) },
            configure = { openAccessMode(AccessMode.LAN, restoreSaved = false) },
        ))
        card.addView(spacer(12))
        card.addView(accessChoice(
            R.string.remote_access_title,
            R.string.remote_access_description,
            legacyCredentialForRestore(AccessMode.REMOTE)?.expiresAt?.let { it > System.currentTimeMillis() } == true,
            action = { openAccessMode(AccessMode.REMOTE, restoreSaved = pairedDeviceStore.load().isEmpty()) },
            configure = { openAccessMode(AccessMode.REMOTE, restoreSaved = false) },
        ))
        card.addView(spacer(12))
        card.addView(accessChoice(
            R.string.iroh_access_title,
            R.string.iroh_access_description,
            false,
            action = { showIrohSetup() },
            configure = { showIrohSetup() },
        ))
    }

    private fun accessChoice(
        titleResource: Int,
        descriptionResource: Int,
        trusted: Boolean,
        action: () -> Unit,
        configure: () -> Unit,
    ): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = roundedRipple(getColor(R.color.app_surface), 18)
            isClickable = true
            isFocusable = true
            contentDescription = getString(titleResource)
            addView(textView(titleResource, 18f, Typeface.BOLD))
            addView(spacer(6))
            addView(textView(descriptionResource, 14f, Typeface.NORMAL, R.color.app_secondary))
            if (trusted) {
                addView(spacer(10))
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    addView(
                        textView(R.string.paired_device_ready, 13f, Typeface.BOLD, R.color.app_accent),
                        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
                    )
                    addView(textView(R.string.reconfigure_connection, 13f, Typeface.BOLD, R.color.app_accent).apply {
                        isClickable = true
                        isFocusable = true
                        setPadding(dp(12), dp(6), 0, dp(6))
                        setOnClickListener { configure() }
                    })
                })
            }
            setOnClickListener { action() }
        }

    private fun openAccessMode(mode: AccessMode, restoreSaved: Boolean = true) {
        cancelAutomaticRecovery()
        invalidateRestoreAttempts()
        connectionCenterStatus = null
        accessMode = mode
        val origin = GatewayOrigin.parse(preferences.getString(originPreference(), "").orEmpty())
        val credential = legacyCredentialForRestore()
        if (restoreSaved && origin != null && credential != null && credential.expiresAt > System.currentTimeMillis()) {
            showRestoringTrust()
            restoreTrustedDevice(origin, credential) {
                if (mode == AccessMode.LAN) showSetup() else showRemoteSetup()
            }
        } else if (mode == AccessMode.LAN) {
            showSetup()
        } else {
            showRemoteSetup()
        }
    }

    private fun showSetup() {
        stopIrohTransport()
        cancelRestoreForConfiguration()
        stopDeviceListRefresh()
        invalidatePairingAttempts()
        deviceListVisible = false
        accessMode = AccessMode.LAN
        showingSetup = true
        setupBackAction = ::showConnectionCenter
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        failureDialog?.dismiss()

        val card = createSetupCard(surface = false)
        card.addView(textView(R.string.discovery_title, 30f, Typeface.BOLD))
        card.addView(spacer(10))
        card.addView(textView(R.string.discovery_description, 16f, Typeface.NORMAL, R.color.app_secondary))
        card.addView(spacer(28))

        val discovery = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
            background = roundedSurface(getColor(R.color.app_surface_translucent), 20).apply {
                setStroke(dp(1), getColor(R.color.app_border))
            }
        }

        val status = TextView(this).apply {
            setText(R.string.scan_prompt)
            setTextColor(getColor(R.color.app_secondary))
            textSize = 15f
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        val results = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scanQr = primaryButton(R.string.scan_action, 56) { openScanner() }
        val scan = primaryButton(R.string.scan_lan, 56) { scanForHarnesses(status, this, results) }
        val manual = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val manualField = field(
            R.string.gateway_hint,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
            EditorInfo.IME_ACTION_GO,
            52,
            R.string.gateway_label,
        )
        val manualAction = { connectManual(manualField.text.toString(), status) }
        val manualConnect = secondaryButton(R.string.connect, 52) { manualAction() }.apply {
            setPadding(dp(12), 0, dp(12), 0)
        }
        manualField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { manualAction(); true } else false
        }
        manual.addView(manualField, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        manual.addView(spacer(8))
        manual.addView(manualConnect, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        discovery.addView(scanQr, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        discovery.addView(spacer(10))
        discovery.addView(scan, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        discovery.addView(spacer(18))
        discovery.addView(status)
        discovery.addView(spacer(12))
        discovery.addView(manual)
        discovery.addView(spacer(12))
        discovery.addView(results, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(discovery, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun showIrohSetup(prefilled: String = "", autoConnect: Boolean = false) {
        stopIrohTransport()
        withdrawConnectionAttempt()
        stopDeviceListRefresh()
        invalidateRestoreAttempts()
        invalidatePairingAttempts()
        deviceListVisible = false
        showingSetup = true
        accessMode = AccessMode.REMOTE
        setupBackAction = ::showConnectionCenter
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        cancelAutomaticRecovery()
        failureDialog?.dismiss()
        val card = createSetupCard(surface = false)
        card.addView(textView(R.string.iroh_access_title, 30f, Typeface.BOLD))
        card.addView(spacer(8))
        card.addView(textView(R.string.iroh_pairing_help, 16f, Typeface.NORMAL, R.color.app_secondary))
        card.addView(spacer(20))
        card.addView(secondaryButton(R.string.scan_action, 52) { openScanner() })
        card.addView(spacer(16))
        card.addView(textView(R.string.iroh_pairing_label, 14f, Typeface.BOLD))
        card.addView(spacer(8))
        val input = field(R.string.iroh_pairing_hint, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_VARIATION_PASSWORD,
            EditorInfo.IME_ACTION_DONE, 96, R.string.iroh_pairing_label).apply {
            isSingleLine = false
            minLines = 3
            maxLines = 4
            isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            imeOptions = imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            transformationMethod = PasswordTransformationMethod.getInstance()
            filters = arrayOf(InputFilter.LengthFilter(IrohPairingDescriptor.MAX_BYTES))
            setText(prefilled)
        }
        card.addView(input)
        card.addView(spacer(12))
        val status = textView(R.string.iroh_pairing_private, 14f, Typeface.NORMAL, R.color.app_secondary).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        val connect = primaryButton(R.string.iroh_connect_action, 52) { }
        fun submit() {
            val descriptor = try { IrohPairingDescriptor.parse(input.text.toString().trim()) } catch (_: Exception) {
                input.error = getString(R.string.iroh_pairing_invalid)
                status.setTextColor(getColor(R.color.app_error))
                status.setText(R.string.iroh_pairing_invalid)
                input.requestFocus()
                return
            }
            if (!prepareCredentialStorage()) return
            input.error = null
            connect.isEnabled = false
            val attempt = startConnectionAttempt(AccessMode.REMOTE, onCancelled = { showIrohSetup() })
            val generation = beginPairingAttempt() ?: run {
                finishConnectionAttempt(attempt)
                connect.isEnabled = true
                return
            }
            fun failed() {
                if (!connectionAttempts.isCurrent(attempt) || generation != pairingGeneration || isFinishing || isDestroyed) return
                stopIrohTransport()
                finishConnectionAttempt(attempt)
                pairingAttemptGate.complete(generation)
                // Pairing may have committed remotely; do not replay either one-time secret.
                input.text.clear()
                input.error = getString(R.string.iroh_pairing_retry_new)
                status.setTextColor(getColor(R.color.app_error))
                status.setText(R.string.iroh_pairing_retry_new)
                connect.isEnabled = true
            }
            startIrohCarrier(descriptor.binding, descriptor.irohCode, attempt, onReady = { carrier ->
                restoreExecutor.execute {
                    val result = runCatching {
                        check(descriptor.expiresAt > System.currentTimeMillis())
                        NativeAuthClient.fetchMetadata(descriptor.binding.origin, attempt.cancellation,
                            IrohHttpsTransport(carrier.endpoint), descriptor.caCertificate)?.let {
                            VersionCompatibility.evaluate(BuildConfig.VERSION_NAME, it)
                                ?.let { issue -> throw IrohCompatibilityFailure(issue) }
                        }
                        NativeAuthClient.pair(descriptor.binding.origin, descriptor.gatewayToken, descriptor.caCertificate,
                            descriptor.instanceId, attempt.cancellation, IrohHttpsTransport(carrier.endpoint))
                    }
                    runOnUiThread {
                        if (!connectionAttempts.isCurrent(attempt) || generation != pairingGeneration || isFinishing || isDestroyed) return@runOnUiThread
                        val session = result.getOrNull()
                        if (session == null) {
                            failed()
                            (result.exceptionOrNull() as? IrohCompatibilityFailure)?.let { showCompatibilityIssue(it.issue, status, connect) }
                            return@runOnUiThread
                        }
                        val token = session.deviceToken
                        val expires = session.deviceExpiresAt
                        if (token == null || expires == null) { failed(); return@runOnUiThread }
                        val existing = pairedDeviceStore.load().any { it.iroh?.endpointId == descriptor.binding.endpointId && it.instanceId == descriptor.instanceId }
                        val credential = DeviceCredential(session.instanceId, token, expires, descriptor.caCertificate)
                        val record = savePairedDevice(AccessMode.REMOTE, descriptor.binding.origin, session, credential)
                            ?: run { failed(); return@runOnUiThread }
                        input.text.clear()
                        installNativeSession(descriptor.binding.origin, session,
                            isCurrent = { connectionAttempts.isCurrent(attempt) && generation == pairingGeneration },
                            onFailure = {
                                stopIrohTransport()
                                finishConnectionAttempt(attempt)
                                pairingAttemptGate.complete(generation)
                                showDeviceList()
                                toastError(R.string.session_storage_failed)
                            }) {
                            pairingAttemptGate.complete(generation)
                            if (existing) showBrowser(descriptor.binding.origin, descriptor.caCertificate)
                            else {
                                finishConnectionAttempt(attempt)
                                showPairedDeviceNamePrompt(record) {
                                    if (generation == pairingGeneration && !isFinishing && !isDestroyed) {
                                        startConnectionAttempt(AccessMode.REMOTE)
                                        showBrowser(descriptor.binding.origin, descriptor.caCertificate)
                                    }
                                }
                            }
                        }
                    }
                }
            }, onFailure = { failed() })
        }
        connect.setOnClickListener { submit() }
        card.addView(connect)
        card.addView(spacer(8))
        card.addView(status)
        card.addView(spacer(16))
        card.addView(secondaryButton(R.string.back_to_connections, 48) { showConnectionCenter() })
        val formGeneration = pairingGeneration
        if (autoConnect) input.post { if (!isFinishing && !isDestroyed && formGeneration == pairingGeneration) submit() }
    }

    private fun showRemoteSetup() {
        stopIrohTransport()
        cancelRestoreForConfiguration()
        stopDeviceListRefresh()
        invalidatePairingAttempts()
        deviceListVisible = false
        accessMode = AccessMode.REMOTE
        showingSetup = true
        setupBackAction = ::showConnectionCenter
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        failureDialog?.dismiss()

        val card = createSetupCard(surface = false)
        card.addView(textView(R.string.remote_setup_title, 30f, Typeface.BOLD))
        card.addView(spacer(10))
        card.addView(textView(R.string.remote_setup_description, 16f, Typeface.NORMAL, R.color.app_secondary))
        card.addView(spacer(24))
        val remote = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
            background = roundedSurface(getColor(R.color.app_surface_translucent), 20).apply {
                setStroke(dp(1), getColor(R.color.app_border))
            }
        }
        remote.addView(textView(R.string.remote_step_one, 15f, Typeface.BOLD))
        remote.addView(spacer(8))
        remote.addView(textView(R.string.remote_step_two, 14f, Typeface.NORMAL, R.color.app_secondary))
        remote.addView(spacer(18))
        remote.addView(primaryButton(R.string.scan_remote_qr, 56) { openScanner() })
        remote.addView(spacer(18))
        val status = TextView(this).apply {
            setTextColor(getColor(R.color.app_secondary))
            textSize = 14f
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        val linkField = field(
            R.string.remote_link_hint,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
            EditorInfo.IME_ACTION_GO,
            52,
            R.string.remote_link_label,
        )
        val connectAction = { connectRemoteLink(linkField.text.toString(), status) }
        linkField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { connectAction(); true } else false
        }
        remote.addView(linkField, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        remote.addView(spacer(10))
        remote.addView(secondaryButton(R.string.connect_remote, 48) { connectAction() }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        remote.addView(spacer(8))
        remote.addView(status)
        card.addView(remote, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(spacer(12))
        card.addView(secondaryButton(R.string.back_to_connections, 48) { showConnectionCenter() }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun connectRemoteLink(raw: String, status: TextView) {
        val connection = GatewayConnection.parse(raw.trim())
        if (connection == null || !isRemoteTunnelHost(connection.origin.host)
            || GatewayUrlPolicy.pairingKey(raw.trim()) == null) {
            status.setTextColor(getColor(R.color.app_error))
            status.setText(R.string.invalid_remote_link)
            status.visibility = View.VISIBLE
            return
        }
        showPairing(manualHarness(connection.origin), prefilledInput = raw.trim(), autoConnect = true)
    }

    private fun isRemoteTunnelHost(host: String): Boolean = RemoteHostPolicy.isRemoteCandidate(host)

    private fun isOriginAllowedForAccessMode(origin: GatewayOrigin): Boolean =
        isOriginAllowed(origin, accessMode)

    private fun isOriginAllowed(origin: GatewayOrigin, mode: AccessMode): Boolean =
        if (IrohDeviceBinding.isIrohHost(origin.host)) {
            mode == AccessMode.REMOTE && activeIroh?.let { it.endpoint.origin == origin && irohController.owns(it.requestId) } == true
        } else RemoteHostPolicy.isAllowed(mode, origin.host)

    private fun hasIrohTransport(binding: IrohDeviceBinding): Boolean =
        BuildConfig.IROH_NATIVE_ENABLED && activeIroh?.let { it.endpoint.origin == binding.origin && it.endpoint.peerId == binding.endpointId && irohController.owns(it.requestId) } == true

    private fun transportFor(origin: GatewayOrigin): TransportEndpoint {
        if (!IrohDeviceBinding.isIrohHost(origin.host)) return LocalTransport
        val session = activeIroh?.takeIf { it.endpoint.origin == origin && irohController.owns(it.requestId) }
            ?: throw NativeAuthFailure(NativeAuthFailureKind.NETWORK)
        return IrohHttpsTransport(session.endpoint)
    }

    private fun stopIrohTransport() {
        stopIrohStatusMonitor()
        irohCancellationRegistration?.invoke()
        irohCancellationRegistration = null
        irohRequestId?.let { irohController.cancel(it) }
        irohRequestId = null
        activeIroh = null
    }

    private class IrohStatusOwner(val carrier: IrohCarrierSession, val browser: WebView, val documentGeneration: Int)

    private val irohStatusMonitor by lazy {
        IrohStatusMonitor<IrohStatusOwner>(
            intervalMs = IROH_STATUS_POLL_MS,
            schedule = { delay, task ->
                restoreUiHandler.postDelayed(task, delay)
                val remove: () -> Unit = { restoreUiHandler.removeCallbacks(task) }
                remove
            },
            captureOwner = {
                val carrier = activeIroh
                val browser = webView
                val generation = secureWebViewClient?.currentDocumentGeneration
                if (!activityResumed || isFinishing || isDestroyed || carrier == null || browser == null
                    || generation == null || gatewayOrigin != carrier.endpoint.origin) null
                else IrohStatusOwner(carrier, browser, generation)
            },
            isCurrent = { owner ->
                activityResumed && !isFinishing && !isDestroyed && activeIroh === owner.carrier
                    && webView === owner.browser && gatewayOrigin == owner.carrier.endpoint.origin
                    && secureWebViewClient?.currentDocumentGeneration == owner.documentGeneration
            },
            status = { owner -> irohController.status(owner.carrier.requestId) },
            onTerminal = { owner, status ->
                when (status) {
                    IrohTransportStatus.REVOKED -> {
                        val origin = owner.carrier.endpoint.origin
                        stopIrohTransport()
                        cancelAutomaticRecovery()
                        handleDeviceRevoked()
                        (application as MobileApplication).sessionCookieInstaller.clear(
                            key = origin.host,
                            cookies = nativeSessionCookieDeletions().map { NativeSessionCookieWrite(origin.serialized, it) },
                            onFailure = {
                                if (!isFinishing && !isDestroyed) toastError(R.string.session_storage_failed)
                            },
                        )
                    }
                    IrohTransportStatus.DISCONNECTED, IrohTransportStatus.INACTIVE -> {
                        stopIrohTransport()
                        showLoadFailure(LoadFailure.NETWORK)
                    }
                    IrohTransportStatus.READY -> Unit
                }
            },
        )
    }

    private fun stopIrohStatusMonitor() = irohStatusMonitor.stop()

    private fun startIrohStatusMonitor() = irohStatusMonitor.start()

    private fun startIrohCarrier(
        binding: IrohDeviceBinding,
        code: String?,
        attempt: ConnectionAttemptController.Attempt,
        onReady: (IrohCarrierSession) -> Unit,
        onFailure: () -> Unit,
    ) {
        if (!BuildConfig.IROH_NATIVE_ENABLED || !binding.isValid()) { onFailure(); return }
        activeIroh = null
        val request = IrohConnectionRequest(binding.endpointId, code,
            Build.MODEL.filterNot(Char::isISOControl).take(64).ifBlank { "Android" }, File(filesDir, "iroh").absolutePath, binding.localPort)
        val id = irohController.connect(request, { session ->
            if (!connectionAttempts.isCurrent(attempt) || isFinishing || isDestroyed || session.endpoint.origin != binding.origin) {
                irohController.cancel(session.requestId)
                return@connect
            }
            activeIroh = session
            onReady(session)
        }, { if (connectionAttempts.isCurrent(attempt) && !isFinishing && !isDestroyed) onFailure() })
        irohRequestId = id
        irohCancellationRegistration?.invoke()
        irohCancellationRegistration = attempt.cancellation.onCancel { irohController.cancel(id) }
    }

    private fun warnIfTailscale(origin: GatewayOrigin) {
        if (!RemoteHostPolicy.needsTailscaleVpnNotice(origin.host)) return
        if (!warnedTailscaleOrigins.add(origin.serialized)) return
        Toast.makeText(this, R.string.tailscale_vpn_warning, Toast.LENGTH_LONG).show()
    }

    private fun showRestoringTrust() {
        withdrawConnectionAttempt()
        stopDeviceListRefresh()
        deviceListVisible = false
        showingSetup = false
        setupBackAction = null
        destroyWebView()
        applyStatusBarIconContrast(window, getColor(R.color.app_background))
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.app_background))
        }
        addSetupArtwork(root)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        content.addView(textView(R.string.restoring_trust, 16f, Typeface.NORMAL, R.color.app_secondary).apply {
            gravity = Gravity.CENTER
        })
        root.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setPageContent(root)
        applySafeAreaInsets(root)
    }

    private fun showPairing(harness: DiscoveredHarness, prefilledInput: String = "", autoConnect: Boolean = false) {
        cancelRestoreForConfiguration()
        stopDeviceListRefresh()
        invalidatePairingAttempts()
        deviceListVisible = false
        showingSetup = true
        setupBackAction = if (accessMode == AccessMode.LAN) ::showSetup else ::showRemoteSetup
        val card = createSetupCard()
        card.addView(textView(R.string.pairing_title, 30f, Typeface.BOLD))
        card.addView(spacer(12))
        card.addView(textView(R.string.pairing_description, 16f, Typeface.NORMAL, R.color.app_secondary))
        card.addView(spacer(24))
        card.addView(textView(R.string.selected_harness, 14f, Typeface.BOLD))
        card.addView(spacer(6))
        card.addView(TextView(this).apply {
            text = "${harness.deviceName}\n${harness.origin.serialized}"
            textSize = 16f
            setTextColor(getColor(R.color.app_foreground))
            setTextIsSelectable(true)
        })
        card.addView(spacer(24))
        card.addView(textView(R.string.pairing_key_label, 14f, Typeface.BOLD))
        card.addView(spacer(8))
        val pairing = field(
            R.string.pairing_key_hint,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            EditorInfo.IME_ACTION_DONE,
            56,
            R.string.pairing_key_label,
        ).apply {
            if (prefilledInput.isNotEmpty()) setText(prefilledInput)
        }
        card.addView(pairing, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(spacer(20))
        val status = TextView(this).apply {
            setTextColor(getColor(R.color.app_error))
            textSize = 14f
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        val connect = primaryButton(R.string.connect, 52) { connect(harness, pairing, status, this) }
        pairing.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                connect(harness, pairing, status, connect)
                true
            } else {
                false
            }
        }
        card.addView(connect, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(spacer(10))
        card.addView(status)
        card.addView(spacer(12))
        card.addView(secondaryButton(R.string.back_to_scan, 48) {
            if (accessMode == AccessMode.LAN) showSetup() else showRemoteSetup()
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        if (autoConnect && prefilledInput.isNotEmpty()) connect(harness, pairing, status, connect)
    }

    private fun createSetupCard(surface: Boolean = true): LinearLayout {
        applyStatusBarIconContrast(window, getColor(R.color.app_background))
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.app_background))
        }
        addSetupArtwork(root)
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
            setPadding(0, dp(24), 0, dp(24))
        }
        root.addView(
            scroll,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            if (surface) {
                setPadding(dp(24), dp(24), dp(24), dp(24))
                background = roundedSurface(getColor(R.color.app_surface), 20).apply {
                    setStroke(dp(1), getColor(R.color.app_border))
                }
            }
        }
        val availableWidth = (resources.displayMetrics.widthPixels - dp(48)).coerceAtLeast(dp(280))
        scroll.addView(
            card,
            FrameLayout.LayoutParams(
                min(availableWidth, dp(560)),
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL,
            ).apply {
                topMargin = dp(24)
                bottomMargin = dp(24)
            },
        )
        scroll.addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
            val width = setupCardWidth(right - left, dp(24), dp(560))
            if (card.layoutParams.width != width) {
                card.layoutParams = card.layoutParams.apply { this.width = width }
            }
        }
        setPageContent(root)
        applySafeAreaInsets(root)
        return card
    }

    /** Pre-connection artwork: covers the whole screen (edges may crop), under a theme-aware scrim. */
    private fun addSetupArtwork(root: FrameLayout) {
        root.addView(
            ImageView(this).apply {
                setImageResource(R.drawable.setup_background_image)
                scaleType = ImageView.ScaleType.CENTER_CROP
            },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        root.addView(
            View(this).apply { setBackgroundColor(getColor(R.color.app_setup_scrim)) },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
    }

    /** Reconnect to a manually entered origin, falling back to pairing when unknown. */
    private fun connectManual(raw: String, status: TextView) {
        val origin = parseManualOrigin(raw)
        if (origin == null) {
            status.setTextColor(getColor(R.color.app_error))
            status.setText(R.string.invalid_gateway)
            status.visibility = View.VISIBLE
            return
        }
        val credential = legacyCredentialForRestore()
        if (credential != null) {
            showRestoringTrust()
            restoreTrustedDevice(origin, credential) { showPairing(manualHarness(origin)) }
        } else {
            showPairing(manualHarness(origin))
        }
    }

    private fun parseManualOrigin(raw: String): GatewayOrigin? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        GatewayOrigin.parse(trimmed)?.let { return it }
        if (!trimmed.startsWith("https://", ignoreCase = true)) {
            return GatewayOrigin.parse("https://$trimmed")
        }
        return null
    }

    /** A pairing screen target whose instance id is unknown until a key or CA is provided. */
    private fun manualHarness(origin: GatewayOrigin): DiscoveredHarness =
        DiscoveredHarness(deviceName = "DeepSeek Harness", origin = origin, instanceId = "")

    private fun connect(harness: DiscoveredHarness, pairing: EditText, status: TextView, button: Button) {
        if (pairingAttemptGate.busy) return
        if (!prepareCredentialStorage()) {
            status.setText(R.string.device_storage_unavailable)
            status.visibility = View.VISIBLE
            return
        }
        val input = pairing.text.toString().trim()
        val directKey = PairingKey.parse(input)
        val connection = if (directKey == null) GatewayConnection.parse(input) else null
        val key = directKey ?: GatewayUrlPolicy.pairingKey(input)
        if (key == null) {
            status.setText(R.string.invalid_pairing_key)
            status.visibility = View.VISIBLE
            pairing.requestFocus()
            return
        }
        // A key is bound to the discovered instance; a pairing link carries its own origin.
        if (directKey != null && harness.instanceId.isNotEmpty() && key.instanceId != harness.instanceId) {
            status.setText(R.string.invalid_pairing_key)
            status.visibility = View.VISIBLE
            pairing.requestFocus()
            return
        }
        val origin = if (directKey != null) harness.origin else connection?.origin ?: harness.origin
        if (!isOriginAllowedForAccessMode(origin)) {
            status.setText(if (accessMode == AccessMode.REMOTE) R.string.invalid_remote_link else R.string.invalid_pairing_key)
            status.visibility = View.VISIBLE
            button.isEnabled = true
            return
        }
        warnIfTailscale(origin)
        val generation = beginPairingAttempt() ?: return
        button.isEnabled = false
        status.setTextColor(getColor(R.color.app_secondary))
        status.setText(R.string.pairing_in_progress)
        status.visibility = View.VISIBLE
        val mode = accessMode
        val store = credentialStore(mode)
        val attempt = startConnectionAttempt(mode, getString(R.string.pairing_in_progress), onCancelled = { reason ->
            button.isEnabled = true
            status.setTextColor(getColor(R.color.app_secondary))
            status.setText(if (reason == ConnectionAttemptController.Reason.TIMED_OUT) R.string.connection_timed_out else R.string.connection_cancelled)
        })
        ioExecutor.execute {
            if (generation != pairingGeneration) return@execute
            val compatibility = runCatching { NativeAuthClient.fetchMetadata(origin, attempt.cancellation) }
                .getOrNull()
                ?.let { VersionCompatibility.evaluate(BuildConfig.VERSION_NAME, it) }
            if (compatibility != null) {
                runOnUiThread {
                    if (generation == pairingGeneration) {
                        completePairingAttempt(generation)
                        showCompatibilityIssue(compatibility, status, button)
                    }
                }
                return@execute
            }
            if (generation != pairingGeneration) return@execute
            val existingRecord = pairedDeviceStore.load().firstOrNull { it.mode == mode && it.instanceId == key.instanceId }
            val savedCredential = legacyCredentialForRestore(mode)
            val savedCa = existingRecord?.caCertificate
                ?: savedCredential?.takeIf { it.instanceId == key.instanceId }?.caCertificate
            val trustKey = PairingTrust.preserveRemotePin(mode, key, savedCa)
            // A LAN gateway always serves its pairing CA. A remote gateway serves one only for the
            // self-signed passthrough entry. A dsh2 key or a previously pinned remote CA requires
            // that exact CA; only a public-CA dsh1 entry may answer 404 and use the system store.
            // The pinned CA also reaches the WebView, the download client and the persisted
            // credential, so restore, renewal and probing keep the very same anchor.
            val trustAttempt = runCatching {
                PairingTrust.selectTrustAnchor(mode, trustKey) {
                    NativeAuthClient.fetchPairingCa(origin, attempt.cancellation)
                }
            }
            val trustFailure = trustAttempt.exceptionOrNull()
            if (trustFailure != null) {
                runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(pairingFailureMessage(trustFailure, origin))
                    completePairingAttempt(generation)
                    button.isEnabled = true
                }
                return@execute
            }
            val trust = trustAttempt.getOrNull()
            if (trust == null) {
                runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(R.string.pairing_tls_failed)
                    completePairingAttempt(generation)
                    button.isEnabled = true
                }
                return@execute
            }
            val (certificate, expectedInstanceId) = trust
            if (generation != pairingGeneration) return@execute
            val savedOrigin = GatewayOrigin.parse(
                preferences.getString(originPreference(mode), "").orEmpty(),
            ) ?: existingRecord?.origin
            val existingCredential = (existingRecord?.credential() ?: savedCredential).takeIf {
                existingRecord?.status != PairedDeviceStatus.REVOKED && ConnectionRestorePolicy.shouldRenewBeforePairing(
                    mode = mode,
                    credential = it,
                    instanceId = key.instanceId,
                    candidateOrigin = origin,
                    savedOrigin = savedOrigin,
                    now = System.currentTimeMillis(),
                )
            }
            if (existingCredential != null) {
                val renewal = runCatching {
                    NativeAuthClient.renew(
                        origin,
                        existingCredential.deviceToken,
                        existingCredential.caCertificate,
                        existingCredential.instanceId,
                        cancellation = attempt.cancellation,
                    )
                }
                val renewed = renewal.getOrNull()
                if (renewed != null) {
                    runOnUiThread {
                        if (generation != pairingGeneration) return@runOnUiThread
                        if (renewed.instanceId != existingCredential.instanceId) {
                            status.setTextColor(getColor(R.color.app_error))
                            status.setText(R.string.pairing_failed)
                            completePairingAttempt(generation)
                            button.isEnabled = true
                        } else {
                            if (savePairedDevice(mode, origin, renewed, existingCredential) == null) {
                                status.setText(R.string.device_storage_unavailable)
                                completePairingAttempt(generation); button.isEnabled = true
                                return@runOnUiThread
                            }
                            installNativeSession(
                                origin = origin,
                                session = renewed,
                                isCurrent = { generation == pairingGeneration && accessMode == mode && connectionAttempts.isCurrent(attempt) },
                                onFailure = {
                                    status.setText(R.string.pairing_failed)
                                    completePairingAttempt(generation)
                                    button.isEnabled = true
                                },
                            ) {
                                pairingAttemptGate.complete(generation)
                                showBrowser(origin, existingCredential.caCertificate)
                            }
                        }
                    }
                    return@execute
                }
                val renewalFailure = renewal.exceptionOrNull() ?: NativeAuthFailure(NativeAuthFailureKind.INVALID_RESPONSE)
                if (generation != pairingGeneration) return@execute
                if (!ConnectionRestorePolicy.mayPairAfterRenewFailure(renewalFailure)) {
                    runOnUiThread {
                        if (generation != pairingGeneration) return@runOnUiThread
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(pairingFailureMessage(renewalFailure, origin))
                        completePairingAttempt(generation)
                        button.isEnabled = true
                    }
                    return@execute
                }
                try {
                    store.clear()
                } catch (_: CredentialStorageUnavailable) {
                    runOnUiThread {
                        if (generation != pairingGeneration) return@runOnUiThread
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(R.string.device_storage_unavailable)
                        completePairingAttempt(generation)
                        button.isEnabled = true
                    }
                    return@execute
                }
            }
            if (generation != pairingGeneration) return@execute
            runCatching { NativeAuthClient.pair(origin, key.token, certificate, key.instanceId, attempt.cancellation) }
                .onSuccess { session -> runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    val deviceToken = session.deviceToken
                    val expiresAt = session.deviceExpiresAt
                    if (deviceToken == null || expiresAt == null
                        || (expectedInstanceId != null && session.instanceId != expectedInstanceId)) {
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(R.string.pairing_failed)
                        completePairingAttempt(generation)
                        button.isEnabled = true
                    } else if (!runCatching {
                            pairedDeviceStore.requireReadable()
                            if (!pairedDeviceStore.isMigrationComplete()) {
                                store.save(DeviceCredential(session.instanceId, deviceToken, expiresAt, certificate))
                            }
                        }.isSuccess) {
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(R.string.device_storage_unavailable)
                        completePairingAttempt(generation)
                        button.isEnabled = true
                    } else {
                        val record = savePairedDevice(
                            mode = mode,
                            origin = origin,
                            session = session,
                            credential = DeviceCredential(session.instanceId, deviceToken, expiresAt, certificate),
                        ) ?: run {
                            status.setText(R.string.device_storage_unavailable)
                            completePairingAttempt(generation); button.isEnabled = true
                            return@runOnUiThread
                        }
                        installNativeSession(
                            origin = origin,
                            session = session,
                            isCurrent = { generation == pairingGeneration && accessMode == mode && connectionAttempts.isCurrent(attempt) },
                            onFailure = {
                                status.setText(R.string.pairing_failed)
                                completePairingAttempt(generation)
                                button.isEnabled = true
                            },
                        ) {
                            pairingAttemptGate.complete(generation)
                            if (record.displayName == localizedDefaultDeviceName(record.mode)) {
                                finishConnectionAttempt(attempt)
                                showPairedDeviceNamePrompt(record) {
                                    if (generation == pairingGeneration && !isFinishing && !isDestroyed) {
                                        startConnectionAttempt(mode)
                                        showBrowser(origin, certificate)
                                    }
                                }
                            } else showBrowser(origin, certificate)
                        }
                    }
                } }
                .onFailure { error -> runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(pairingFailureMessage(error, origin))
                    completePairingAttempt(generation)
                    button.isEnabled = true
                } }
        }
    }

    private fun showCompatibilityIssue(issue: CompatibilityIssue, status: TextView, button: Button) {
        button.isEnabled = true
        status.setTextColor(getColor(R.color.app_error))
        val required = issue.requiredVersion.orEmpty()
        val (title, message) = when (issue.kind) {
            CompatibilityIssueKind.APP_TOO_OLD -> R.string.app_update_required_title to getString(R.string.app_update_required_message, required)
            CompatibilityIssueKind.PLUGIN_TOO_OLD -> R.string.plugin_update_required_title to getString(R.string.plugin_update_required_message, required)
            CompatibilityIssueKind.PROTOCOL_UNSUPPORTED -> R.string.connection_version_mismatch_title to getString(R.string.connection_version_mismatch_message)
        }
        status.text = message
        status.visibility = View.VISIBLE
        val dialog = AlertDialog.Builder(this).setTitle(title).setMessage(message)
        if (issue.kind == CompatibilityIssueKind.APP_TOO_OLD) {
            dialog.setPositiveButton(R.string.download_update) { _, _ -> openExternal(Uri.parse(APP_RELEASES_URL)) }
                .setNegativeButton(R.string.cancel, null)
        } else {
            dialog.setPositiveButton(android.R.string.ok, null)
        }
        dialog.show()
    }

    private fun pairingFailureMessage(error: Throwable, origin: GatewayOrigin): Int = when ((error as? NativeAuthFailure)?.kind) {
        NativeAuthFailureKind.PAIRING_EXPIRED -> R.string.pairing_expired
        NativeAuthFailureKind.DEVICE_REVOKED -> R.string.device_revoked_message
        NativeAuthFailureKind.DEVICE_EXPIRED -> R.string.pairing_expired
        NativeAuthFailureKind.DEVICE_LIMIT -> R.string.pairing_device_limit
        NativeAuthFailureKind.RATE_LIMITED -> R.string.pairing_rate_limited
        NativeAuthFailureKind.TIMEOUT -> if (RemoteHostPolicy.needsTailscaleVpnNotice(origin.host)) R.string.pairing_tailscale_unreachable else R.string.pairing_timeout
        NativeAuthFailureKind.TLS -> if (RemoteHostPolicy.needsTailscaleVpnNotice(origin.host)) R.string.pairing_tailscale_unreachable else R.string.pairing_tls_failed
        NativeAuthFailureKind.NETWORK -> if (RemoteHostPolicy.needsTailscaleVpnNotice(origin.host)) R.string.pairing_tailscale_unreachable else R.string.pairing_network_failed
        NativeAuthFailureKind.SERVER_UNAVAILABLE -> R.string.pairing_server_unavailable
        NativeAuthFailureKind.INVALID_RESPONSE, null -> R.string.pairing_failed
    }

    private var scanCanceled = AtomicBoolean(false)

    private fun scanForHarnesses(status: TextView, button: Button, results: LinearLayout) {
        val nearbyGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
        if (nearbyGranted && nearbyPermissionLimited) {
            nearbyPermissionLimited = false
            preferences.edit().remove(PREFERENCE_NEARBY_PERMISSION_LIMITED).apply()
        }
        if (NearbyDiscoveryPermissionPolicy.shouldRequest(Build.VERSION.SDK_INT, nearbyGranted, nearbyPermissionLimited)) {
            pendingScan = { scanForHarnesses(status, button, results) }
            requestPermissions(arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES), NEARBY_WIFI_REQUEST)
            return
        }
        button.isEnabled = false
        val scanCancellation = AtomicBoolean(false)
        scanCanceled = scanCancellation
        results.removeAllViews()
        status.setTextColor(getColor(R.color.app_secondary))
        status.setText(if (nearbyPermissionLimited) R.string.scanning_lan_limited else R.string.scanning_lan)
        status.visibility = View.VISIBLE
        val attempt = startConnectionAttempt(AccessMode.LAN, status.text, onCancelled = { reason ->
            button.isEnabled = true
            results.removeAllViews()
            status.setTextColor(getColor(R.color.app_secondary))
            status.setText(if (reason == ConnectionAttemptController.Reason.TIMED_OUT) R.string.connection_timed_out else R.string.scan_prompt)
        })

        val cancelButton = Button(this).apply {
            setText(R.string.cancel)
            isAllCaps = false
            textSize = 15f
            minHeight = dp(48)
            backgroundTintList = null
            background = roundedRipple(getColor(R.color.app_surface_tinted), 12)
            setTextColor(getColor(R.color.app_foreground))
        }
        cancelButton.setOnClickListener {
            connectionAttempts.cancel(attempt)
        }
        results.addView(cancelButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        ioExecutor.execute {
            if (attempt.cancellation.isCancelled) return@execute
            val found = runCatching { LanDiscovery.scan(this, canceled = scanCancellation, cancellation = attempt.cancellation) }.getOrDefault(emptyList())
            runOnUiThread {
                if (!connectionAttempts.isCurrent(attempt) || isFinishing || isDestroyed) return@runOnUiThread
                finishConnectionAttempt(attempt)
                button.isEnabled = true
                cancelButton.isEnabled = true
                cancelButton.visibility = View.GONE
                if (scanCancellation.get()) {
                    status.setTextColor(getColor(R.color.app_secondary))
                    status.setText(R.string.scan_prompt)
                } else if (found.isEmpty()) {
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(R.string.no_harness_found)
                } else {
                    status.setTextColor(getColor(R.color.app_secondary))
                    status.text = resources.getQuantityString(R.plurals.harnesses_found, found.size, found.size)
                    found.forEachIndexed { index, harness ->
                        if (index > 0) results.addView(spacer(8))
                        val trustedCredential = pairedDeviceStore.load()
                            .firstOrNull { it.mode == AccessMode.LAN && it.instanceId == harness.instanceId && it.expiresAt > System.currentTimeMillis() }
                            ?.credential()
                            ?: legacyCredentialForRestore(AccessMode.LAN)?.takeIf {
                                it.expiresAt > System.currentTimeMillis() && it.instanceId == harness.instanceId
                            }
                        val trusted = trustedCredential != null
                        results.addView(Button(this).apply {
                            text = getString(R.string.harness_list_item, harness.deviceName, harness.origin.serialized)
                            isAllCaps = false
                            gravity = Gravity.START or Gravity.CENTER_VERTICAL
                            minHeight = dp(68)
                            textSize = 15f
                            setTextColor(getColor(R.color.app_foreground))
                            backgroundTintList = null
                            background = roundedRipple(getColor(R.color.app_surface_tinted), 16)
                            contentDescription = getString(
                                if (trusted) R.string.open_harness_trusted else R.string.open_harness_pairing,
                                harness.deviceName,
                            )
                            setOnClickListener {
                                if (trustedCredential != null) {
                                    showRestoringTrust()
                                    restoreTrustedDevice(harness.origin, trustedCredential) { showPairing(harness) }
                                } else {
                                    showPairing(harness)
                                }
                            }
                        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                    }
                }
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (nativeBridge?.onRequestPermissionsResult(requestCode, grantResults) == true) return
        if (requestCode == NativeBridge.CAMERA_PERMISSION_REQUEST) {
            deferredBridgePermission = grantResults.copyOf()
            return
        }
        when (requestCode) {
            TASK_NOTIFICATION_PERMISSION_REQUEST -> {
                toast(
                    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                        R.string.task_notifications_enabled
                    } else {
                        R.string.task_notifications_denied
                    },
                )
            }
            NEARBY_WIFI_REQUEST -> {
                val retry = pendingScan
                pendingScan = null
                nearbyPermissionLimited = grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED
                preferences.edit().apply {
                    if (nearbyPermissionLimited) putBoolean(PREFERENCE_NEARBY_PERMISSION_LIMITED, true)
                    else remove(PREFERENCE_NEARBY_PERMISSION_LIMITED)
                }.apply()
                retry?.invoke()
            }
            SCAN_CAMERA_REQUEST -> {
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startScanActivity()
                else toastError(R.string.scan_camera_denied)
            }
            VOICE_PERMISSION_REQUEST -> {
                val pending = pendingAudioPermission
                pendingAudioPermission = null
                if (pending != null) {
                    val currentPage = webView === pending.owner && gatewayOrigin == pending.origin &&
                        GatewayUrlPolicy.isSameOrigin(pending.origin, pending.owner.url ?: "") && !isFinishing
                    val granted = permissions.size == 1 && permissions[0] == Manifest.permission.RECORD_AUDIO &&
                        grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
                    if (granted && currentPage) {
                        audioCaptureGrantedBrowser = pending.owner
                        pending.request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        pending.request.deny()
                    }
                }
            }
            else -> Unit
        }
    }

    /** Open the QR scanner, requesting the CAMERA permission once when needed. */
    private fun openScanner() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), SCAN_CAMERA_REQUEST)
            return
        }
        startScanActivity()
    }

    private fun startScanActivity() {
        startActivityForResult(Intent(this, ScanActivity::class.java), SCAN_QR_REQUEST)
    }

    private fun finishScanResult(resultCode: Int, data: Intent?) {
        if (resultCode != RESULT_OK) return
        val text = data?.getStringExtra(ScanActivity.EXTRA_QR_RESULT)?.trim().orEmpty()
        if (text.isEmpty()) return
        if (BuildConfig.IROH_NATIVE_ENABLED && text.startsWith('{')) {
            try { IrohPairingDescriptor.parse(text) } catch (_: Exception) {
                toastError(R.string.iroh_pairing_invalid)
                return
            }
            showIrohSetup(text, autoConnect = true)
            return
        }
        val target = PairingScanPolicy.parse(text, accessMode)
        if (target != null) {
            accessMode = target.mode
            showPairing(manualHarness(target.connection.origin), prefilledInput = text, autoConnect = true)
            return
        }
        toastError(R.string.scan_result_invalid)
    }

    private fun installNativeSession(
        origin: GatewayOrigin,
        session: NativeSession,
        isCurrent: () -> Boolean,
        onFailure: () -> Unit,
        complete: () -> Unit,
    ) {
        if (!isCurrent() || session.origin != origin) return
        (application as MobileApplication).sessionCookieInstaller.install(
            key = origin.host,
            cookies = nativeSessionCookies(session).map { NativeSessionCookieWrite(origin.serialized, it) },
            isCurrent = { !isFinishing && !isDestroyed && isCurrent() },
            onFailure = onFailure,
            complete = complete,
        )
    }

    private fun savePairedDevice(
        mode: AccessMode,
        origin: GatewayOrigin,
        session: NativeSession,
        credential: DeviceCredential,
        activate: Boolean = true,
    ): PairedDeviceRecord? {
        dismissDeviceUndo()
        val binding = activeIroh?.takeIf { it.endpoint.origin == origin && irohController.owns(it.requestId) }
            ?.endpoint?.let { IrohDeviceBinding(it.peerId, it.localPort) }
        if (IrohDeviceBinding.isIrohHost(origin.host) && binding == null) return null
        val key = binding?.let { "iroh:${it.endpointId}:${session.instanceId}" } ?: "${mode.name.lowercase()}:${session.instanceId}"
        val existing = pairedDeviceStore.load().firstOrNull { it.key == key }
        val name = existing?.displayName ?: localizedDefaultDeviceName(mode)
        val token = session.deviceToken ?: credential.deviceToken
        val expiresAt = session.deviceExpiresAt ?: credential.expiresAt
        val now = System.currentTimeMillis()
        val record = PairedDeviceRecord(
                instanceId = session.instanceId,
                deviceId = session.deviceId,
                displayName = name,
                mode = mode,
                origin = origin,
                deviceToken = token,
                expiresAt = expiresAt,
                caCertificate = credential.caCertificate,
                lastConnectedAt = now,
                lastReachableAt = now,
                status = PairedDeviceStatus.REACHABLE,
                installationId = session.installationId ?: existing?.takeIf { it.deviceToken == token }?.installationId,
                iroh = binding,
        )
        if (withCredentialStorage { pairedDeviceStore.upsert(record) } == null) return null
        if (activate) activatePairedDevice(record)
        return record
    }

    private fun activatePairedDevice(record: PairedDeviceRecord) {
        activeDeviceKey = record.key
        preferences.edit()
            .putString(PREFERENCE_LAST_DEVICE_KEY, record.key)
            .putLong(lastConnectedPreference(record.mode), record.lastConnectedAt ?: System.currentTimeMillis())
            .putString(originPreference(record.mode), record.origin.serialized)
            .apply()
    }

    private fun showPairedDeviceNamePrompt(record: PairedDeviceRecord, complete: () -> Unit) {
        val input = EditText(this).apply {
            setText(record.displayName)
            setSelection(text.length)
            hint = getString(R.string.device_name_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minHeight = dp(48)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.name_new_device)
            .setMessage(R.string.name_new_device_message)
            .setView(input)
            .setNegativeButton(R.string.skip) { _, _ -> complete() }
            .setPositiveButton(R.string.save_and_connect, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val name = java.text.Normalizer.normalize(input.text.toString(), java.text.Normalizer.Form.NFC).trim()
                if (name.length !in 1..32 || Regex("[\\u0000-\\u001f\\u007f]").containsMatchIn(name)) {
                    Toast.makeText(this, R.string.invalid_device_name, Toast.LENGTH_SHORT).show()
                } else {
                    if (withCredentialStorage { pairedDeviceStore.update(record.key) { it.copy(displayName = name) } } == null) return@setOnClickListener
                    dialog.dismiss()
                    complete()
                }
            }
        }
        dialog.setOnCancelListener { complete() }
        dialog.show()
    }

    private fun handleDeviceRevoked() {
        val key = activeDeviceKey ?: return
        withCredentialStorage { pairedDeviceStore.update(key) { it.copy(status = PairedDeviceStatus.REVOKED) } }
        runOnUiThread {
            if (activeDeviceKey != key || isFinishing || isDestroyed) return@runOnUiThread
            activeDeviceKey = null
            destroyWebView()
            Toast.makeText(this, R.string.device_revoked_message, Toast.LENGTH_LONG).show()
            showDeviceList()
        }
    }

    private val sameHostGate = SameHostSwitchGate()
    private val sameHostMonitor by lazy { SameHostNetworkMonitor(this, ::checkSameHostConnection) }
    private var capturedDraft: Pair<WebView, org.json.JSONObject>? = null
    private fun releaseCapturedDraft() {
        capturedDraft?.let { (browser, snapshot) -> PlainTextDraftTransfer(restoreUiHandler).release(browser, snapshot) }
        capturedDraft = null
        webView?.setOnTouchListener(null)
    }
    private var draftTransfer: PlainTextDraftTransfer? = null
    private var sameHostConfirmation: AlertDialog? = null
    private var sameHostRestoreAttempt: ConnectionAttemptController.Attempt? = null
    private var sameHostProbeCancellation: NativeConnectionCancellation? = null
    private var sameHostObservedWifi: Boolean? = null
    private fun sameHostMode() = SameHostSwitchMode.resolve(preferences.getString("same_host_mode", null),
        preferences.getBoolean("automatic_same_host", false))
    private fun automaticSameHost() = sameHostMode() != SameHostSwitchMode.MANUAL

    private fun showSameHostSettings() {
        val choices = arrayOf(getString(R.string.same_host_manual), getString(R.string.same_host_detect), getString(R.string.same_host_enable))
        AlertDialog.Builder(this).setTitle(R.string.same_host_title)
            .setSingleChoiceItems(choices, sameHostMode().ordinal) { dialog, which ->
                fun save() {
                    preferences.edit().putString("same_host_mode", SameHostSwitchMode.entries[which].name).apply()
                    sameHostGate.invalidate()
                    sameHostProbeCancellation?.cancel()
                    sameHostProbeCancellation = null
                    sameHostConfirmation?.dismiss()
                    checkSameHostConnection()
                }
                dialog.dismiss()
                if (which == SameHostSwitchMode.AUTOMATIC.ordinal) {
                    AlertDialog.Builder(this).setTitle(R.string.same_host_enable).setMessage(R.string.same_host_limits)
                        .setNegativeButton(R.string.cancel, null)
                        .setPositiveButton(R.string.same_host_enable) { _, _ -> save() }.show()
                } else save()
            }
            .setNegativeButton(R.string.cancel, null).show()
    }

    /** Only authenticated probes can trigger recovery or offer a voluntary LAN return. */
    private fun checkSameHostConnection() {
        if (!automaticSameHost() || showingSetup || sameHostRestoreAttempt != null || sameHostConfirmation != null ||
            (webView != null && recoveryStoppedBrowser === webView)) return
        val rows = pairedDeviceStore.load()
        val active = rows.firstOrNull { it.key == activeDeviceKey } ?: return
        if (!SameHostSwitchPolicy.eligible(active, System.currentTimeMillis())) return
        // Probe the independently paired remote endpoint while LAN renewal may still be running.
        // No credential or TLS policy is borrowed from the current endpoint.
        val wifi = sameHostMonitor.hasWifi()
        if (sameHostObservedWifi != null && sameHostObservedWifi != wifi) {
            sameHostProbeCancellation?.cancel()
            sameHostProbeCancellation = null
            sameHostGate.networkChanged()
        }
        sameHostObservedWifi = wifi
        val proactiveRemote = active.mode == AccessMode.LAN && !wifi
        if (!proactiveRemote && (pendingConnection != null || restoreAttemptGate.restorePending)) return
        val target = when {
            proactiveRemote -> SameHostSwitchPolicy.candidate(active, rows, AccessMode.REMOTE, System.currentTimeMillis())
            active.mode == AccessMode.REMOTE -> SameHostSwitchPolicy.candidate(active, rows, AccessMode.LAN, System.currentTimeMillis())
            else -> active
        } ?: return
        val owner = sameHostGate.begin(android.os.SystemClock.elapsedRealtime()) ?: return
        val restoreOwner = restoreGeneration
        val sourceBrowser = webView
        val sourceOrigin = gatewayOrigin
        val sourceDocument = secureWebViewClient?.currentDocumentGeneration
        val cancellation = NativeConnectionCancellation { task -> connectionCancellationExecutor.execute(task) }
        sameHostProbeCancellation = cancellation
        val timeout = Runnable {
            cancellation.cancel()
            sameHostGate.finish(owner)
            if (sameHostProbeCancellation === cancellation) sameHostProbeCancellation = null
        }
        restoreUiHandler.postDelayed(timeout, 10_000)
        restoreWorkGate.submit(
            key = "${target.instanceId}:${target.deviceToken}",
            workExecutor = sameHostProbeExecutor,
            isCurrent = { sameHostGate.current(owner) && !cancellation.isCancelled },
            onRejected = { runOnUiThread {
                restoreUiHandler.removeCallbacks(timeout)
                if (sameHostProbeCancellation === cancellation) sameHostProbeCancellation = null
                sameHostGate.finish(owner)
            } },
        ) {
            val result = runCatching { NativeAuthClient.probe(target.origin, target.deviceToken, target.caCertificate,
                target.instanceId, cancellation) }
            runOnUiThread {
                restoreUiHandler.removeCallbacks(timeout)
                if (sameHostProbeCancellation === cancellation) sameHostProbeCancellation = null
                if (!sameHostGate.current(owner)) return@runOnUiThread
                if (cancellation.isCancelled) { sameHostGate.finish(owner); return@runOnUiThread }
                sameHostGate.finish(owner)
                if (restoreGeneration != restoreOwner || showingSetup || activeDeviceKey != active.key ||
                    (!proactiveRemote && pendingConnection != null)) return@runOnUiThread
                if (webView !== sourceBrowser || gatewayOrigin != sourceOrigin ||
                    secureWebViewClient?.currentDocumentGeneration != sourceDocument) return@runOnUiThread
                if (proactiveRemote && sameHostMonitor.hasWifi()) return@runOnUiThread
                val current = pairedDeviceStore.load().firstOrNull { it.key == target.key } ?: return@runOnUiThread
                if (!PairedDeviceStatusPolicy.mayApplyResult(current, target)) return@runOnUiThread
                val updated = PairedDeviceStatusPolicy.applyProbe(current, target, result.getOrNull(),
                    (result.exceptionOrNull() as? NativeAuthFailure)?.kind, System.currentTimeMillis())
                withCredentialStorage { pairedDeviceStore.update(target.key) { updated } }
                if (target.key != active.key && result.isSuccess && updated.status == PairedDeviceStatus.REACHABLE &&
                    updated.installationId == active.installationId) {
                    requestSameHostSwitch(active, updated) { }
                } else if (target.key == active.key && result.isFailure &&
                    ConnectionRestorePolicy.failureDisposition(result.exceptionOrNull(), false) == RestoreFailureDisposition.RETRY_TRANSIENT) {
                    recoverAutomatically()
                }
            }
        }
    }

    /** A cross-Origin reload has no public draft/attachment export; never silently replace a mounted page. */
    private fun requestSameHostSwitch(from: PairedDeviceRecord, to: PairedDeviceRecord, failure: () -> Unit): Boolean {
        if (!automaticSameHost() || !sameHostGate.foreground || !sameHostGate.reserveSwitch(android.os.SystemClock.elapsedRealtime())) return false
        withdrawConnectionAttempt()
        cancelAutomaticRecovery()
        invalidateRestoreAttempts()
        finishConnectionAttempt()
        val generation = restoreGeneration
        val lifecycleOwner = sameHostGate.generation
        val sourceOrigin = gatewayOrigin
        val browser = webView
        val silent = !SameHostSwitchPolicy.requiresConfirmation(sameHostMode(), browser != null)
        var snapshot: org.json.JSONObject? = null
        fun connect() {
            if (webView !== browser || gatewayOrigin != sourceOrigin) return
            if (!sameHostGate.foreground || lifecycleOwner != sameHostGate.generation || isFinishing || isDestroyed || generation != restoreGeneration || activeDeviceKey != from.key || !automaticSameHost()) return
            val rows = pairedDeviceStore.load()
            val latest = rows.firstOrNull { it.key == to.key } ?: return
            val source = rows.firstOrNull { it.key == from.key } ?: return
            if (!PairedDeviceStatusPolicy.mayApplyResult(source, from) || !PairedDeviceStatusPolicy.mayApplyResult(latest, to) ||
                SameHostSwitchPolicy.candidate(source, listOf(latest), latest.mode, System.currentTimeMillis()) == null) return
            finishConnectionAttempt()
            if (snapshot != null) { browser?.clearFocus(); browser?.setOnTouchListener { _, _ -> true } }
            restoreTrustedDevice(latest.origin, latest.credential(), latest.mode, beginRestoreAttempt(),
                deviceKey = latest.key, preserveWebView = browser, deferActivation = true,
                claimSuccess = { sameHostGate.foreground && lifecycleOwner == sameHostGate.generation &&
                    webView === browser && gatewayOrigin == sourceOrigin && automaticSameHost() },
                onAuthenticated = if (snapshot != null && browser != null) { targetOrigin, saved, settled ->
                    val authOwner = pendingConnection
                    stagePlainTextTransfer(browser, sourceOrigin!!, targetOrigin, latest, saved, snapshot!!,
                        lifecycleOwner, { settled(); if (sameHostRestoreAttempt === authOwner) sameHostRestoreAttempt = null })
                } else null,
                onActivated = {
                    if (pendingConnection === sameHostRestoreAttempt) sameHostRestoreAttempt = null
                    if (silent) Toast.makeText(this, R.string.same_host_switched, Toast.LENGTH_LONG).show()
                }) {
                finishConnectionAttempt()
                sameHostRestoreAttempt = null
                browser?.setOnTouchListener(null)
                if (browser != null && snapshot != null) PlainTextDraftTransfer(restoreUiHandler).release(browser, snapshot!!)
                if (browser != null && webView === browser) {
                    Toast.makeText(this, R.string.background_restore_failed, Toast.LENGTH_LONG).show()
                } else failure()
            }
            sameHostRestoreAttempt = pendingConnection
        }
        fun confirm() {
            if (!sameHostGate.foreground || lifecycleOwner != sameHostGate.generation || generation != restoreGeneration || webView !== browser || showingSetup || isFinishing || isDestroyed) return
            finishConnectionAttempt()
            sameHostConfirmation = AlertDialog.Builder(this).setTitle(R.string.same_host_switch_title)
                .setMessage(R.string.same_host_switch_warning)
                .setNegativeButton(R.string.cancel) { _, _ -> finishConnectionAttempt() }
                .setPositiveButton(R.string.same_host_switch_confirm) { _, _ -> connect() }
                .create().also { dialog ->
                    dialog.setOnDismissListener { sameHostConfirmation = null }
                    dialog.show()
                }
        }
        if (sameHostMode() == SameHostSwitchMode.AUTOMATIC && browser != null &&
            pendingAudioPermission == null && audioCaptureGrantedBrowser !== browser && !fileChooserTransitions.active &&
            !webFileChooser.active && nativeBridge?.hasPendingTransferBlockers() != true) {
            browser.setOnTouchListener { _, _ -> true }
            val transfer = PlainTextDraftTransfer(restoreUiHandler)
            transfer.capture(browser) { captured ->
                browser.setOnTouchListener(null)
                if (webView !== browser || gatewayOrigin != sourceOrigin || !sameHostGate.foreground ||
                    lifecycleOwner != sameHostGate.generation) {
                    if (captured != null) transfer.release(browser, captured)
                    return@capture
                }
                snapshot = captured
                if (captured != null) capturedDraft = browser to captured
                if (captured == null) confirm() else connect()
            }
        } else if (silent) connect() else confirm()
        return true
    }

    private fun stagePlainTextTransfer(source: WebView, sourceOrigin: GatewayOrigin, targetOrigin: GatewayOrigin,
        requested: PairedDeviceRecord, saved: PairedDeviceRecord, snapshot: org.json.JSONObject,
        lifecycleOwner: Int, settled: () -> Unit) {
        val sourceKey = activeDeviceKey
        val sourceRecord = pairedDeviceStore.load().firstOrNull { it.key == sourceKey }
        val generation = restoreGeneration
        val target = WebView(this)
        configureWebViewHttpCache(target)
        val parent = source.parent as? ViewGroup
        if (parent == null) { target.destroy(); releaseCapturedDraft(); settled(); return }
        val shield = View(this).apply { isClickable = true; isFocusableInTouchMode = true }
        parent.addView(target, ViewGroup.LayoutParams(source.width, source.height))
        target.alpha = 0f
        target.setOnTouchListener { _, _ -> true }
        parent.addView(shield, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shield.requestFocus()
        target.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true; mediaPlaybackRequiresUserGesture = true
            javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false)
            userAgentString = "$userAgentString DSHMobile/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(target, false)
        installBrowserCompatibilityShim(target, targetOrigin)
        // WebMessage objects are injected only for navigations after listener registration.
        // Keep the staged document inert until this exact browser becomes the active page.
        val targetBridge = NativeBridge(this, target, targetOrigin, activeOwner = {
            webView === target && gatewayOrigin == targetOrigin && !isFinishing && !isDestroyed
        })
        if (!runCatching { targetBridge.install() }.getOrDefault(false)) {
            targetBridge.dispose(); parent.removeView(target); target.destroy(); parent.removeView(shield)
            releaseCapturedDraft(); settled()
            return
        }
        val transfer = PlainTextDraftTransfer(restoreUiHandler)
        draftTransfer = transfer
        var failed = false
        val sourceUri = Uri.parse(snapshot.getString("href"))
        val url = targetOrigin.serialized.trimEnd('/') + (sourceUri.encodedPath ?: "/") +
            (sourceUri.encodedQuery?.let { "?$it" } ?: "") + (sourceUri.encodedFragment?.let { "#$it" } ?: "")
        val client = SecureWebViewClient(targetOrigin, requested.caCertificate,
            openExternal = { failed = true; transfer.abort() }, onBlocked = { failed = true; transfer.abort() },
            onFailure = { failed = true; transfer.abort() }, onRendererGone = { failed = true; transfer.abort() },
            onTopLevelUrlChanged = { changed -> if (changed != url) { failed = true; transfer.abort() } },
            onLoaded = {}, onBeforeTopLevelNavigation = {})
        target.webViewClient = client
        transfer.restore(source, target, snapshot, current = {
            val rows = pairedDeviceStore.load()
            !failed && sameHostGate.foreground && lifecycleOwner == sameHostGate.generation &&
                generation == restoreGeneration && automaticSameHost() && webView === source &&
                gatewayOrigin == sourceOrigin && activeDeviceKey == sourceKey && !isFinishing && !isDestroyed &&
                sourceRecord != null && rows.any { it.key == sourceKey && PairedDeviceStatusPolicy.mayApplyResult(it, sourceRecord) } &&
                rows.any { it.key == saved.key && PairedDeviceStatusPolicy.mayApplyResult(it, saved) } &&
                pendingAudioPermission == null && audioCaptureGrantedBrowser !== source &&
                !webFileChooser.active && !fileChooserTransitions.active &&
                nativeBridge?.hasPendingTransferBlockers() != true &&
                client.currentDocumentGeneration <= 1 && (target.url == null || target.url == url)
        }, onAbort = {
            client.dispose(); targetBridge.dispose(); parent.removeView(target); target.destroy(); parent.removeView(shield)
            if (draftTransfer === transfer) {
                source.setOnTouchListener(null); draftTransfer = null
                if (capturedDraft?.second?.optString("token") == snapshot.optString("token")) capturedDraft = null
            }
            settled()
            if (sameHostGate.foreground && lifecycleOwner == sameHostGate.generation &&
                generation == restoreGeneration && webView === source && gatewayOrigin == sourceOrigin &&
                activeDeviceKey == sourceKey && !isFinishing && !isDestroyed) {
                Toast.makeText(this, R.string.same_host_migration_retained, Toast.LENGTH_LONG).show()
            }
        }, onCommit = {
            client.dispose(); parent.removeView(shield); parent.removeView(target)
            accessMode = saved.mode; activatePairedDevice(saved); draftTransfer = null; capturedDraft = null
            settled()
            showBrowser(targetOrigin, requested.caCertificate, url, stagedBrowser = StagedBrowser(target, targetBridge))
            Toast.makeText(this, R.string.same_host_switched, Toast.LENGTH_LONG).show()
        })
        target.loadUrl(url)
    }

    private fun trySameHostFallback(from: PairedDeviceRecord, disposition: RestoreFailureDisposition, failure: () -> Unit): Boolean {
        if (!automaticSameHost() || from.mode != AccessMode.LAN || !SameHostSwitchPolicy.mayFallback(disposition)) return false
        val target = SameHostSwitchPolicy.candidate(from, pairedDeviceStore.load(), AccessMode.REMOTE, System.currentTimeMillis()) ?: return false
        return requestSameHostSwitch(from, target, failure)
    }

    private fun recoverAutomatically() {
        if (initialPageLoadPending()) return
        loadingConnectionAttempt = null
        loadingDocumentGeneration = null
        pageReadyCheck?.let(restoreUiHandler::removeCallbacks)
        pageReadyCheck = null
        val paired = activeDeviceKey?.let { key -> pairedDeviceStore.load().firstOrNull { it.key == key } }
        if (paired != null) {
            if (paired.status == PairedDeviceStatus.REVOKED
                || paired.status == PairedDeviceStatus.EXPIRED
                || paired.status == PairedDeviceStatus.ADDRESS_CHANGED
                || paired.expiresAt <= System.currentTimeMillis()
            ) {
                cancelAutomaticRecovery()
                if (!isFinishing && !isDestroyed) showDeviceList()
                return
            }
            val generation = beginRestoreAttempt()
            restoreTrustedDevice(
                paired.origin,
                paired.credential(),
                paired.mode,
                generation,
                deviceKey = paired.key,
                preserveWebView = webView,
            ) { disposition ->
                if (trySameHostFallback(paired, disposition) { showDeviceList() }) return@restoreTrustedDevice
                if (disposition == RestoreFailureDisposition.RETRY_TRANSIENT) {
                    if (!scheduleAutomaticRecovery()) finishAutomaticRecoveryAfterRetryBudget { showDeviceList() }
                } else {
                    cancelAutomaticRecovery()
                    if (!isFinishing && !isDestroyed) showDeviceList()
                }
            }
            return
        }
        val mode = accessMode
        val credential = legacyCredentialForRestore(mode) ?: run {
            showConnectionCenter()
            return
        }
        if (credential.expiresAt <= System.currentTimeMillis()) {
            withCredentialStorage { credentialStore(mode).clear() }
            showConnectionCenter()
            return
        }
        val preferred = gatewayOrigin
            ?: GatewayOrigin.parse(preferences.getString(originPreference(mode), "").orEmpty())
            ?: run {
                showConnectionCenter()
                return
            }
        val generation = beginRestoreAttempt()
        restoreTrustedDevice(preferred, credential, mode, generation, preserveWebView = webView) { disposition ->
            if (disposition == RestoreFailureDisposition.RETRY_TRANSIENT) {
                if (!scheduleAutomaticRecovery()) finishAutomaticRecoveryAfterRetryBudget { showConnectionCenter() }
            } else {
                cancelAutomaticRecovery()
                showConnectionCenter()
            }
        }
    }

    private fun canRecoverAutomatically(): Boolean {
        if (webView != null && recoveryStoppedBrowser === webView) return false
        val paired = activeDeviceKey?.let { key -> pairedDeviceStore.load().firstOrNull { it.key == key } }
        if (paired != null) {
            return paired.status != PairedDeviceStatus.REVOKED
                && paired.status != PairedDeviceStatus.EXPIRED
                && paired.status != PairedDeviceStatus.ADDRESS_CHANGED
                && paired.expiresAt > System.currentTimeMillis()
        }
        return legacyCredentialForRestore()?.expiresAt?.let { it > System.currentTimeMillis() } == true
    }

    private fun scheduleAutomaticRecovery(): Boolean {
        if (recoveryScheduled || restoreAttemptGate.restorePending) return true
        if (recoveryAttempt >= RECOVERY_DELAYS_MS.size || !canRecoverAutomatically()) return false
        if (pendingConnection == null) startConnectionAttempt(accessMode, preserveBrowser = webView)
        val delay = RECOVERY_DELAYS_MS[recoveryAttempt++]
        recoveryHandler.postDelayed(restoreAttemptGate.retryCallback {
            if (!isFinishing && !isDestroyed) recoverAutomatically()
        }, delay)
        return true
    }

    private fun cancelAutomaticRecovery() {
        recoveryHandler.removeCallbacksAndMessages(null)
        recoveryAttempt = 0
        restoreAttemptGate.cancelRetry()
    }

    /** A mounted page can retain its retry dialog; an absent or failed page needs the native connection screen. */
    private fun finishAutomaticRecoveryAfterRetryBudget(fallback: () -> Unit) {
        if (isFinishing || isDestroyed) return
        val candidate = webView
        val origin = gatewayOrigin
        if (candidate == null || origin == null) {
            fallback()
            return
        }
        val generation = restoreGeneration
        probeMountedDshPage(candidate, origin) { mounted ->
            if (isFinishing || isDestroyed) return@probeMountedDshPage
            when (exhaustedRecoveryAction(generation, restoreGeneration, webView === candidate, mounted)) {
                ExhaustedRecoveryAction.IGNORE -> Unit
                ExhaustedRecoveryAction.KEEP_PAGE -> {
                    finishConnectionAttempt()
                    showLoadFailure(LoadFailure.NETWORK)
                }
                ExhaustedRecoveryAction.SHOW_CONNECTIONS -> fallback()
            }
        }
    }

    private fun beginRestoreAttempt(): Int {
        bridgeSessionRenewal.cancel()
        return restoreAttemptGate.begin()
    }

    private fun invalidateRestoreAttempts(errorCode: String = "cancelled") {
        draftTransfer?.abort()
        releaseCapturedDraft()
        bridgeSessionRenewal.cancel(errorCode = errorCode)
        restoreAttemptGate.invalidate()
        connectionCenterStatus?.visibility = View.GONE
    }

    private fun cancelRestoreForConfiguration() {
        sameHostGate.invalidate()
        sameHostProbeCancellation?.cancel()
        sameHostProbeCancellation = null
        sameHostConfirmation?.dismiss()
        withdrawConnectionAttempt()
        cancelAutomaticRecovery()
        invalidateRestoreAttempts()
    }

    private fun beginPairingAttempt(): Int? = pairingAttemptGate.begin()

    private fun completePairingAttempt(generation: Int) {
        if (pairingAttemptGate.complete(generation)) finishConnectionAttempt()
    }

    private fun invalidatePairingAttempts() {
        pairingAttemptGate.invalidate()
    }

    /** Trust restoration distinguishes an absent record from temporarily unreadable encrypted storage. */
    private fun readPairedRestoreRecords(): List<PairedDeviceRecord>? = when (val current = pairedDeviceStore.read()) {
        CredentialRead.Absent -> emptyList()
        CredentialRead.Unreadable -> { showCredentialStorageFailure(); null }
        is CredentialRead.Loaded -> current.value
    }

    /** Renew only the credential and document which requested the bridge operation. */
    private fun renewSessionFromPage(
        requestId: String,
        browser: WebView,
        origin: GatewayOrigin,
        bridgeIsCurrent: () -> Boolean,
        done: (Boolean, String?) -> Unit,
    ) {
        val documentGeneration = secureWebViewClient?.currentDocumentGeneration
        if (!bridgeIsCurrent() || webView !== browser || gatewayOrigin != origin || documentGeneration == null
            || fileChooserTransitions.active || isFinishing || isDestroyed
            || !isDshDocumentUrl(origin, browser.url.orEmpty())) {
            done(false, "cancelled")
            return
        }
        if (recoveryStoppedBrowser === browser) {
            done(false, "cancelled")
            return
        }
        if (bridgeSessionRenewal.pending || pendingConnection != null || restoreAttemptGate.restorePending || recoveryScheduled) {
            done(false, "busy")
            return
        }
        val key = activeDeviceKey
        val devices = readPairedRestoreRecords()
        if (devices == null) {
            done(false, "unavailable")
            return
        }
        val device = devices.firstOrNull { it.key == key && it.origin == origin }
        if (key == null || device == null) {
            done(false, "no_credential")
            return
        }
        if (device.status == PairedDeviceStatus.REVOKED || device.status == PairedDeviceStatus.EXPIRED
            || device.status == PairedDeviceStatus.ADDRESS_CHANGED || device.expiresAt <= System.currentTimeMillis()) {
            done(false, "authentication_failed")
            return
        }
        val generation = beginRestoreAttempt()
        // The existing connection owns the overall deadline and visible Stop action.
        val attempt = startConnectionAttempt(device.mode, preserveBrowser = browser, keepVisibleDocument = true)
        val request = bridgeSessionRenewal.begin(requestId) { errorCode -> done(errorCode == null, errorCode) }
        if (request == null) {
            finishConnectionAttempt(attempt)
            done(false, "busy")
            return
        }
        fun ownsDocument(): Boolean = bridgeSessionRenewal.isCurrent(request) && bridgeIsCurrent()
            && webView === browser && gatewayOrigin == origin && activeDeviceKey == key
            && secureWebViewClient?.currentDocumentGeneration == documentGeneration
            && !fileChooserTransitions.active && !isFinishing && !isDestroyed
            && isDshDocumentUrl(origin, browser.url.orEmpty())
        try {
            restoreTrustedDevice(
                preferredOrigin = origin,
                credential = device.credential(),
                mode = device.mode,
                generation = generation,
                deviceKey = key,
                preserveWebView = browser,
                requestIsCurrent = ::ownsDocument,
                allowOriginRediscovery = false,
                onSessionInstalled = {
                    finishConnectionAttempt(attempt)
                    bridgeSessionRenewal.finish(request)
                },
                onUnavailable = {
                    finishConnectionAttempt(attempt)
                    bridgeSessionRenewal.finish(request, "unavailable")
                },
            ) { disposition ->
                finishConnectionAttempt(attempt)
                bridgeSessionRenewal.finish(request, if (disposition == RestoreFailureDisposition.RETRY_TRANSIENT) "transient" else "authentication_failed")
            }
        } catch (_: Exception) {
            finishConnectionAttempt(attempt)
            bridgeSessionRenewal.finish(request, "unavailable")
        }
    }

    /** A new document withdraws the old page's native waiter and physical transport. */
    private fun cancelPageSessionRenewal(requestId: String? = null) {
        if (!bridgeSessionRenewal.cancel(requestId)) return
        withdrawConnectionAttempt()
        cancelAutomaticRecovery()
        invalidateRestoreAttempts()
    }

    private fun restoreTrustedDevice(
        preferredOrigin: GatewayOrigin,
        credential: DeviceCredential,
        mode: AccessMode = accessMode,
        generation: Int = beginRestoreAttempt(),
        deviceKey: String? = null,
        preserveWebView: WebView? = null,
        deferActivation: Boolean = false,
        claimSuccess: () -> Boolean = { true },
        onActivated: () -> Unit = {},
        onAuthenticated: ((GatewayOrigin, PairedDeviceRecord, () -> Unit) -> Unit)? = null,
        requestIsCurrent: () -> Boolean = { true },
        allowOriginRediscovery: Boolean = true,
        onSessionInstalled: (() -> Unit)? = null,
        onUnavailable: (() -> Unit)? = null,
        onFailure: (RestoreFailureDisposition) -> Unit,
    ) {
        fun unavailable() {
            restoreAttemptGate.completeRestore(generation)
            if (onUnavailable != null) onUnavailable() else onFailure(RestoreFailureDisposition.REQUIRE_USER_ACTION)
        }
        val requestedDevice = if (deviceKey == null) null else {
            val records = readPairedRestoreRecords() ?: run { unavailable(); return }
            records.firstOrNull { it.key == deviceKey }
        }
        if (deviceKey != null && (requestedDevice == null || requestedDevice.status == PairedDeviceStatus.REVOKED)) {
            finishConnectionAttempt()
            onFailure(RestoreFailureDisposition.REQUIRE_USER_ACTION)
            return
        }
        if (requestedDevice?.iroh != null && !hasIrohTransport(requestedDevice.iroh)) {
            val transportAttempt = pendingConnection ?: startConnectionAttempt(mode,
                message = getString(R.string.connecting_to_device, requestedDevice.displayName), preserveBrowser = preserveWebView)
            val carrierReady = restoreAttemptGate.connectionCallback(generation, connectionAttempts, transportAttempt) {
                restoreTrustedDevice(preferredOrigin, credential, mode, generation, deviceKey, preserveWebView, deferActivation, claimSuccess, onActivated, onAuthenticated, requestIsCurrent, allowOriginRediscovery, onSessionInstalled, onUnavailable, onFailure)
            }
            val carrierFailed = restoreAttemptGate.connectionCallback(generation, connectionAttempts, transportAttempt) {
                // The caller owns retry or terminal UI; a carrier failure does not reset its deadline.
                onFailure(RestoreFailureDisposition.RETRY_TRANSIENT)
            }
            startIrohCarrier(requestedDevice.iroh, null, transportAttempt,
                onReady = { carrierReady.run() }, onFailure = carrierFailed::run)
            return
        }
        if (!isOriginAllowed(preferredOrigin, mode)) {
            if (deviceKey != null) withCredentialStorage { pairedDeviceStore.update(deviceKey) {
                if (it.status == PairedDeviceStatus.REVOKED) it else it.copy(status = PairedDeviceStatus.ADDRESS_CHANGED)
            }
            } else {
                if (withCredentialStorage { credentialStore(mode).clear() } != null) {
                    preferences.edit().remove(originPreference(mode)).apply()
                }
            }
            if (generation == restoreGeneration) {
                finishConnectionAttempt()
                onFailure(RestoreFailureDisposition.REQUIRE_USER_ACTION)
            }
            return
        }
        val attempt = pendingConnection ?: startConnectionAttempt(
            mode,
            message = requestedDevice?.let { getString(R.string.connecting_to_device, it.displayName) }
                ?: getString(R.string.restoring_trust),
            preserveBrowser = preserveWebView,
        )
        if (!restoreAttemptGate.claimRestore(generation)) return
        // A credential keeps its physical slot across Origin rediscovery and local cancellation.
        val workKey = "${credential.instanceId}:${credential.deviceToken}"
        restoreWorkGate.submit(
            key = workKey,
            isCurrent = { restoreAttemptGate.isCurrent(generation) && !attempt.cancellation.isCancelled },
            onRejected = {
                runOnUiThread(restoreAttemptGate.callback(generation) {
                    restoreAttemptGate.completeRestore(generation)
                    if (!isFinishing && !isDestroyed && connectionAttempts.isCurrent(attempt)) {
                        onFailure(RestoreFailureDisposition.RETRY_TRANSIENT)
                    }
                })
            },
        ) restore@ {
            var selectedOrigin = preferredOrigin
            var lastFailure: Throwable? = null
            var instanceMismatch = false

            fun renew(origin: GatewayOrigin): NativeSession? {
                lastFailure = null
                instanceMismatch = false
                return try {
                    NativeAuthClient.renew(
                        origin,
                        credential.deviceToken,
                        credential.caCertificate,
                        credential.instanceId,
                        cancellation = attempt.cancellation,
                        transport = transportFor(origin),
                    ).also { session ->
                        if (session.instanceId != credential.instanceId ||
                            (onAuthenticated != null && (requestedDevice?.installationId == null ||
                                session.installationId != requestedDevice.installationId)) ||
                            (requestedDevice?.installationId != null && session.installationId != null &&
                                requestedDevice.installationId != session.installationId) ||
                            (requestedDevice?.deviceId?.isNotEmpty() == true && requestedDevice.deviceId != session.deviceId)) instanceMismatch = true
                    }.takeUnless { instanceMismatch }
                } catch (failure: Exception) {
                    lastFailure = failure
                    null
                }
            }

            var session = renew(selectedOrigin)
            var disposition = ConnectionRestorePolicy.failureDisposition(lastFailure, instanceMismatch)
            if (generation != restoreGeneration) return@restore
            if (session == null && allowOriginRediscovery && mode == AccessMode.LAN && disposition == RestoreFailureDisposition.RETRY_TRANSIENT) {
                val found = runCatching { LanDiscovery.scan(this, cancellation = attempt.cancellation) }.getOrDefault(emptyList())
                    .singleOrNull { it.instanceId == credential.instanceId }
                if (generation != restoreGeneration) return@restore
                if (found != null) {
                    selectedOrigin = found.origin
                    session = renew(selectedOrigin)
                    disposition = ConnectionRestorePolicy.failureDisposition(lastFailure, instanceMismatch)
                }
            }

            val renewed = session
            val finalDisposition = disposition
            val failureKind = (lastFailure as? NativeAuthFailure)?.kind
            runOnUiThread(restoreAttemptGate.callback(generation) {
                if (isFinishing || isDestroyed || !connectionAttempts.isCurrent(attempt) || !requestIsCurrent()) {
                    restoreAttemptGate.completeRestore(generation)
                    return@callback
                }
                if (deviceKey != null) {
                    val records = readPairedRestoreRecords() ?: run { unavailable(); return@callback }
                    val current = records.firstOrNull { it.key == deviceKey }
                    if (current == null || requestedDevice == null ||
                        !PairedDeviceStatusPolicy.mayApplyResult(current, requestedDevice)
                    ) {
                        restoreAttemptGate.completeRestore(generation)
                        onFailure(RestoreFailureDisposition.REQUIRE_USER_ACTION)
                        return@callback
                    }
                }
                if (renewed == null) {
                    if (requestedDevice?.iroh != null && failureKind in setOf(NativeAuthFailureKind.NETWORK, NativeAuthFailureKind.TIMEOUT)) {
                        // A dead QUIC carrier is recreated before the next bounded retry.
                        stopIrohTransport()
                    }
                    if (deviceKey != null) {
                        val status = when (failureKind) {
                            NativeAuthFailureKind.DEVICE_REVOKED -> PairedDeviceStatus.REVOKED
                            NativeAuthFailureKind.DEVICE_EXPIRED,
                            NativeAuthFailureKind.PAIRING_EXPIRED,
                            -> PairedDeviceStatus.EXPIRED
                            else -> if (instanceMismatch) PairedDeviceStatus.ADDRESS_CHANGED else PairedDeviceStatus.UNREACHABLE
                        }
                        withCredentialStorage { pairedDeviceStore.update(deviceKey) { it.copy(status = status) } }
                    } else if (failureKind == NativeAuthFailureKind.PAIRING_EXPIRED) {
                        withCredentialStorage { credentialStore(mode).clear() }
                    }
                    restoreAttemptGate.completeRestore(generation)
                    onFailure(finalDisposition)
                } else {
                    if (!claimSuccess()) {
                        restoreAttemptGate.completeRestore(generation)
                        return@callback
                    }
                    if (!deferActivation) accessMode = mode
                    val saved = savePairedDevice(mode, selectedOrigin, renewed, credential, activate = !deferActivation)
                    if (saved == null) {
                        unavailable()
                        return@callback
                    }
                    warnIfTailscale(selectedOrigin)
                    cancelAutomaticRecovery()
                    installNativeSession(
                        origin = selectedOrigin,
                        session = renewed,
                        isCurrent = { restoreAttemptGate.isCurrent(generation) && connectionAttempts.isCurrent(attempt) && requestIsCurrent() && claimSuccess() },
                        onFailure = ::unavailable,
                    ) {
                        if (onAuthenticated != null) {
                            onAuthenticated(selectedOrigin, saved) {
                                restoreAttemptGate.completeRestore(generation)
                                finishConnectionAttempt(attempt)
                            }
                            return@installNativeSession
                        }
                        if (deferActivation) {
                            if (!claimSuccess()) {
                                restoreAttemptGate.completeRestore(generation)
                                finishConnectionAttempt(attempt)
                                return@installNativeSession
                            }
                            accessMode = mode
                            activatePairedDevice(saved)
                        }
                        onActivated()
                        restoreAttemptGate.completeRestore(generation)
                        if (onSessionInstalled != null) onSessionInstalled()
                        else if (preserveWebView == null) {
                            failureDialog?.dismiss()
                            showBrowser(selectedOrigin, credential.caCertificate)
                        }
                        else preserveLiveDocumentOrReload(
                            preserveWebView,
                            selectedOrigin,
                            credential.caCertificate,
                            generation,
                        )
                    }
                }
            })
        }
    }

    /** The dedicated React shell appears after DSH boot; HTML completion alone is not readiness. */
    private fun probeMountedDshPage(
        candidate: WebView,
        origin: GatewayOrigin,
        script: String = MOUNTED_DSH_PROBE,
        complete: (Boolean) -> Unit,
    ) {
        if (webView !== candidate || gatewayOrigin != origin || !isDshDocumentUrl(origin, candidate.url.orEmpty())) {
            complete(false)
            return
        }
        val completed = AtomicBoolean(false)
        val timeout = Runnable { if (completed.compareAndSet(false, true)) complete(false) }
        restoreUiHandler.postDelayed(timeout, LIVE_DOCUMENT_PROBE_TIMEOUT_MS)
        runCatching {
            candidate.evaluateJavascript(script) { result ->
                if (!completed.compareAndSet(false, true)) return@evaluateJavascript
                restoreUiHandler.removeCallbacks(timeout)
                complete(mountedDshProbeResult(result))
            }
        }.onFailure {
            if (completed.compareAndSet(false, true)) {
                restoreUiHandler.removeCallbacks(timeout)
                complete(false)
            }
        }
    }

    /** Keep the existing page after cookie renewal only if DSH is still mounted inside it. */
    private fun preserveLiveDocumentOrReload(
        candidate: WebView,
        origin: GatewayOrigin,
        caCertificate: ByteArray?,
        generation: Int,
    ) {
        val fallbackUrl = candidate.url?.takeIf { isDshDocumentUrl(origin, it) } ?: origin.serialized
        val action = { mounted: Boolean ->
            if (isFinishing || isDestroyed) RenewedDocumentAction.IGNORE
            else renewedDocumentAction(
                generation,
                restoreGeneration,
                webView === candidate,
                gatewayOrigin == origin,
                mounted,
            )
        }
        val reload = {
            if (action(false) == RenewedDocumentAction.RELOAD) {
                failureDialog?.dismiss()
                showBrowser(origin, caCertificate, fallbackUrl)
            }
        }
        if (action(false) == RenewedDocumentAction.IGNORE) return
        if (gatewayOrigin != origin) {
            reload()
            return
        }
        probeMountedDshPage(candidate, origin) { mounted ->
            when (action(mounted)) {
                RenewedDocumentAction.IGNORE -> Unit
                RenewedDocumentAction.KEEP -> {
                    failureDialog?.dismiss()
                    finishConnectionAttempt()
                }
                RenewedDocumentAction.RELOAD -> reload()
            }
        }
    }

    /** HTML completion alone does not release the initial connection's cancel button or deadline. */
    private fun finishConnectionWhenPageReady(
        browser: WebView,
        origin: GatewayOrigin,
        attempt: ConnectionAttemptController.Attempt,
        documentGeneration: Int,
    ) {
        if (loadingDocumentGeneration != documentGeneration
            || secureWebViewClient?.currentDocumentGeneration != documentGeneration
            || loadingConnectionAttempt !== attempt || !connectionAttempts.isCurrent(attempt)
            || webView !== browser || isFinishing || isDestroyed) return
        probeMountedDshPage(browser, origin, INITIAL_DSH_READY_PROBE) { mounted ->
            if (loadingDocumentGeneration != documentGeneration
                || secureWebViewClient?.currentDocumentGeneration != documentGeneration
                || loadingConnectionAttempt !== attempt || !connectionAttempts.isCurrent(attempt)
                || webView !== browser || isFinishing || isDestroyed) return@probeMountedDshPage
            if (mounted) {
                if (secureWebViewClient?.confirmContentReady(documentGeneration) == true) {
                    nativeBridge?.injectPage()
                    finishConnectionAttempt(attempt)
                }
            }
            else {
                pageReadyCheck?.let(restoreUiHandler::removeCallbacks)
                pageReadyCheck = Runnable { finishConnectionWhenPageReady(browser, origin, attempt, documentGeneration) }
                    .also { restoreUiHandler.postDelayed(it, PAGE_READY_POLL_MS) }
            }
        }
    }

    private fun handleRendererGone(browser: WebView) {
        if (webView !== browser || isFinishing || isDestroyed) return
        invalidateRestoreAttempts()
        val decision = rendererRecoveryDecision(rendererCrashTimes, SystemClock.elapsedRealtime())
        rendererCrashTimes = decision.recentCrashes
        destroyWebView(rendererGone = true)
        if (!decision.retry) {
            showDeviceList()
            deviceListStatus?.apply {
                setText(R.string.webview_renderer_failed)
                setTextColor(getColor(R.color.app_error))
            }
            return
        }
        showRestoringTrust()
        if (!scheduleAutomaticRecovery()) showDeviceList()
    }

    private fun offerWebViewEngineUpdate(browser: WebView) {
        val provider = WebView.getCurrentWebViewPackage()
        val engine = inspectWebViewEngine(browser.settings.userAgentString, provider?.packageName, provider?.versionName)
        if (!engine.needsUpdateReminder) return
        val acknowledged = preferences.getStringSet("webview_update_reminder_engines", emptySet()).orEmpty()
        if (engine.reminderKey in acknowledged) return
        preferences.edit().putStringSet("webview_update_reminder_engines", acknowledged + engine.reminderKey).apply()
        val providerLabel = listOfNotNull(engine.providerPackage, engine.providerVersion).joinToString(" ")
        AlertDialog.Builder(this)
            .setTitle(R.string.webview_update_title)
            .setMessage(getString(R.string.webview_update_message, engine.chromiumVersion, providerLabel))
            .setPositiveButton(R.string.webview_update_action) { _, _ ->
                val providerPackage = engine.providerPackage
                if (providerPackage == "com.google.android.webview" || providerPackage == "com.android.chrome") {
                    openExternal(Uri.parse("https://play.google.com/store/apps/details?id=$providerPackage"))
                } else if (providerPackage != null) {
                    try {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$providerPackage")))
                    } catch (_: ActivityNotFoundException) {
                        openExternal(Uri.parse("https://developer.android.com/develop/ui/views/layout/webapps/managing-webview"))
                    }
                } else {
                    openExternal(Uri.parse("https://developer.android.com/develop/ui/views/layout/webapps/managing-webview"))
                }
            }
            .setNegativeButton(R.string.webview_continue, null)
            .show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showBrowser(
        origin: GatewayOrigin,
        caCertificate: ByteArray?,
        requestedInitialUrl: String = origin.serialized,
        stagedBrowser: StagedBrowser? = null,
    ) {
        if (!isOriginAllowedForAccessMode(origin)) {
            val cleared = withCredentialStorage { credentialStore().clear() } != null
            if (cleared) preferences.edit().remove(originPreference()).apply()
            showConnectionCenter()
            if (!cleared) showCredentialStorageFailure()
            return
        }
        if (pendingConnection == null) startConnectionAttempt(accessMode)
        // The pairing form no longer owns cancellation once it has opened a browser.
        connectionCancellationAction = { showConnectionCenter() }
        restoreConnectionWaitingScreen()
        connectionCancelButton?.setText(R.string.connection_cancel)
        destroyWebView()
        stopDeviceListRefresh()
        deviceListVisible = false
        showingSetup = false
        setupBackAction = null
        gatewayOrigin = origin
        cancelAutomaticRecovery()
        preferences.edit()
            .putString(originPreference(), origin.serialized)
            .putString(PREFERENCE_LAST_ACCESS_MODE, accessMode.name)
            .apply()

        // Every DSH page and third-party overlay shares the native safe viewport.
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.app_background))
        }
        val initialChromeColor = preferences.getInt(PREFERENCE_WEB_CHROME_COLOR, getColor(R.color.app_background))
        root.setBackgroundColor(initialChromeColor)
        applyStatusBarIconContrast(window, initialChromeColor)
        val statusBarBackdrop = View(this).apply {
            setBackgroundColor(initialChromeColor)
        }
        window.isNavigationBarContrastEnforced = false
        val browser = stagedBrowser?.browser ?: WebView(this)
        (browser.parent as? ViewGroup)?.removeView(browser)
        browser.alpha = 1f
        browser.setOnTouchListener(null)
        configureWebViewHttpCache(browser)
        webView = browser
        loadingConnectionAttempt = pendingConnection
        recoveryStoppedBrowser = null
        browser.setBackgroundColor(getColor(R.color.app_background))
        browser.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString DSHMobile/${BuildConfig.VERSION_NAME}"
        }
        val displayScale = NativeDisplayScale(browser, origin,
            preferences.getInt("web_page_scale_percent", NativeDisplayScalePolicy.DEFAULT_PERCENT))
        browser.addOnLayoutChangeListener { _, left, _, right, _, oldLeft, _, oldRight, _ ->
            if (right - left != oldRight - oldLeft) displayScale.apply()
        }
        if (stagedBrowser == null) installBrowserCompatibilityShim(browser, origin)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(browser, false)
        }
        fun ownsBrowser(): Boolean = webView === browser && gatewayOrigin == origin && !isFinishing && !isDestroyed
        fun withdrawPageReadiness() {
            loadingDocumentGeneration = null
            pageReadyCheck?.let(restoreUiHandler::removeCallbacks)
            pageReadyCheck = null
            restoreConnectionWaitingScreen()
        }
        fun inspectVisibleContent(generation: Int) {
            val attempt = loadingConnectionAttempt ?: return
            if (!ownsBrowser() || !connectionAttempts.isCurrent(attempt)
                || secureWebViewClient?.currentDocumentGeneration != generation) return
            loadingDocumentGeneration = generation
            revealConnectionPage(browser, attempt, generation)
            finishConnectionWhenPageReady(browser, origin, attempt, generation)
        }
        if (androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.NAVIGATION_LISTENER)) {
            val listener = object : androidx.webkit.NavigationListener {
                override fun onNavigationStarted(navigation: androidx.webkit.Navigation) {
                    if (ownsBrowser() && !navigation.isSameDocument && fileChooserTransitions.begin(navigation)) {
                        cancelPageSessionRenewal()
                        withdrawPageReadiness()
                        invalidateWebFileChooser()
                    }
                }

                override fun onNavigationCompleted(navigation: androidx.webkit.Navigation) {
                    if (ownsBrowser()) fileChooserTransitions.complete(navigation)
                }
            }
            fileChooserNavigationListener = listener
            // A posted cancellation can outlive the frame that owns its Chromium callback.
            androidx.webkit.WebViewCompat.addNavigationListener(browser, java.util.concurrent.Executor { task -> task.run() }, listener)
        }
        val secureClient = SecureWebViewClient(
            origin = origin,
            onBeforeTopLevelNavigation = {
                if (ownsBrowser() && fileChooserNavigationListener == null) {
                    cancelPageSessionRenewal()
                    withdrawPageReadiness()
                    cancelWebFileChooser()
                }
            },
            caCertificate = caCertificate,
            openExternal = { uri ->
                if (ownsBrowser()) openExternal(uri)
            },
            onBlocked = {
                if (ownsBrowser()) toastError(R.string.blocked_navigation)
            },
            onFailure = { failure ->
                if (ownsBrowser() && recoveryStoppedBrowser !== browser) showLoadFailure(failure)
            },
            onRendererGone = {
                if (ownsBrowser()) handleRendererGone(browser)
            },
            onTopLevelUrlChanged = {
                if (ownsBrowser()) {
                    cancelPageSessionRenewal()
                    withdrawPageReadiness()
                    if (fileChooserNavigationListener == null) invalidateWebFileChooser()
                    displayScale.onDocumentStarted()
                    cancelPendingWebBack()
                    pendingAudioPermission = null
                    if (audioCaptureGrantedBrowser === browser) audioCaptureGrantedBrowser = null
                    nativeBridge?.onTopLevelNavigation(it)
                }
            },
            onLoaded = {
                if (ownsBrowser()) {
                    displayScale.onDocumentReady()
                    retryUrl = origin.serialized
                    CookieManager.getInstance().flush()
                    nativeBridge?.injectPage()
                    secureWebViewClient?.currentDocumentGeneration?.let(::inspectVisibleContent)
                }
            },
            onContentVisible = { generation ->
                if (ownsBrowser()) {
                    displayScale.onDocumentReady()
                    inspectVisibleContent(generation)
                }
            },
            connectionDeadlineActive = { ownsBrowser() && initialPageLoadPending() },
        )
        secureWebViewClient = secureClient
        browser.webViewClient = secureClient
        browser.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean = showFileChooser(webView, origin, filePathCallback, fileChooserParams)

            override fun onPermissionRequest(request: PermissionRequest) {
                // DSH's voice input records through getUserMedia, which only the
                // paired page may do, and only once RECORD_AUDIO is held.
                val allowed = WebViewPermissionPolicy.shouldGrantAudioCapture(
                    request.resources.toList(),
                    request.origin?.toString(),
                    origin,
                ) && webView === browser && gatewayOrigin == origin &&
                    GatewayUrlPolicy.isSameOrigin(origin, browser.url ?: "") && !isFinishing
                if (!allowed) {
                    request.deny()
                    return
                }
                if (pendingAudioPermission?.request === request) return
                if (pendingAudioPermission != null) {
                    request.deny()
                    return
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    audioCaptureGrantedBrowser = browser
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    return
                }
                pendingAudioPermission = PendingAudioPermission(request, browser, origin)
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), VOICE_PERMISSION_REQUEST)
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingAudioPermission?.request === request) pendingAudioPermission = null
            }
        }
        nativeBridge?.dispose()
        val bridgeState = restoredNativeBridgeState.also { restoredNativeBridgeState = null }
        nativeBridge = (stagedBrowser?.bridge ?: NativeBridge(this, browser, origin, bridgeState)).also { bridge ->
            bridge.onPageBackgroundColor = { color ->
                root.setBackgroundColor(color)
                statusBarBackdrop.setBackgroundColor(color)
                if (connectionWaitingView == null || connectionPageVisible) applyStatusBarIconContrast(window, color)
                preferences.edit().putInt(PREFERENCE_WEB_CHROME_COLOR, color).apply()
            }
            bridge.onDeviceRevoked = ::handleDeviceRevoked
            bridge.onRenewSession = { requestId, isCurrent, done ->
                renewSessionFromPage(requestId, browser, origin, isCurrent, done)
            }
            bridge.onCancelRenewSession = ::cancelPageSessionRenewal
            bridge.onSwitchComputer = ::showDeviceList
            bridge.onOpenTaskNotificationSettings = ::openTaskNotificationSettings
            bridge.onGetDisplayScale = { displayScale.percent }
            bridge.onSetDisplayScale = { percent ->
                displayScale.set(percent)
                preferences.edit().putInt("web_page_scale_percent", percent).apply()
            }
            bridge.install()
            deferredBridgeResult?.let { result ->
                if (bridge.onActivityResult(result.requestCode, result.resultCode, result.data)) deferredBridgeResult = null
            }
            deferredBridgePermission?.let { grants ->
                if (bridge.onRequestPermissionsResult(NativeBridge.CAMERA_PERMISSION_REQUEST, grants)) deferredBridgePermission = null
            }
        }
        browser.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            requestDownload(origin, caCertificate, url, userAgent, contentDisposition, mimeType)
        }
        root.addView(browser, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(statusBarBackdrop, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.TOP))
        setPageContent(root)

        // Reserve each occupied edge once. Chromium receives consumed insets,
        // preventing safe-area CSS from adding the same navigation or IME gap.
        root.setOnApplyWindowInsetsListener { _, insets ->
            val safeArea = resolveWebViewSafeArea(insets)
            val ime = resolveWebViewImeInset(insets)
            nativeBridge?.updateKeyboardState(resolveNativeKeyboardState(ime, resources.configuration.keyboard))
            val browserLayout = browser.layoutParams as FrameLayout.LayoutParams
            if (browserLayout.leftMargin != safeArea.left || browserLayout.topMargin != safeArea.top ||
                browserLayout.rightMargin != safeArea.right || browserLayout.bottomMargin != safeArea.bottom
            ) {
                browserLayout.leftMargin = safeArea.left
                browserLayout.topMargin = safeArea.top
                browserLayout.rightMargin = safeArea.right
                browserLayout.bottomMargin = safeArea.bottom
                browser.layoutParams = browserLayout
            }
            val backdropLayout = statusBarBackdrop.layoutParams as FrameLayout.LayoutParams
            if (backdropLayout.height != safeArea.top) {
                backdropLayout.height = safeArea.top
                statusBarBackdrop.layoutParams = backdropLayout
            }
            insetsForWebContent(insets)
        }
        root.requestApplyInsets()
        root.post { if (webView === browser && !isFinishing) offerWebViewEngineUpdate(browser) }
        val initialUrl = requestedInitialUrl.takeIf { GatewayUrlPolicy.isSameOrigin(origin, it) }
            ?: origin.serialized
        retryUrl = initialUrl
        startIrohStatusMonitor()
        if (stagedBrowser == null) browser.loadUrl(initialUrl)
        else { displayScale.onDocumentReady(); nativeBridge?.injectPage(); finishConnectionAttempt() }
    }

    /** Request task-reminder permission in foreground, or open its system settings once decided. */
    private fun openTaskNotificationSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !preferences.getBoolean(PREFERENCE_NOTIFICATION_PERMISSION_REQUESTED, false)
        ) {
            preferences.edit().putBoolean(PREFERENCE_NOTIFICATION_PERMISSION_REQUESTED, true).apply()
            requestPermissions(
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                TASK_NOTIFICATION_PERMISSION_REQUEST,
            )
            return
        }
        val settings = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        }
        try {
            startActivity(settings)
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    private fun showFileChooser(
        browser: WebView,
        origin: GatewayOrigin,
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        val owner = WebFileChooserOwner(browser, origin.serialized, fileChooserDocument)
        if (!isCurrentFileChooser(owner)) {
            respondToFileChooser(callback, null)
            return true
        }
        cancelWebFileChooser()
        val request = webFileChooser.begin(PendingWebFileChooser(owner, callback))
        if (request == null) {
            respondToFileChooser(callback, null)
            if (isCurrentFileChooser(owner)) toastError(R.string.file_picker_unavailable)
            return true
        }
        val mimeTypes = acceptedMimeTypes(params.acceptTypes)
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val photoMime = photoPickerMimeType(
            Build.VERSION.SDK_INT,
            mimeTypes,
            params.isCaptureEnabled,
            params.mode == WebChromeClient.FileChooserParams.MODE_OPEN || multiple,
        )
        if (photoMime != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val limit = if (multiple) runCatching { MediaStore.getPickImagesMaxLimit() }.getOrNull() else null
            if (!multiple || (limit != null && photoPickerSelectionLimit(true, limit) != null)) {
                val photo = Intent(MediaStore.ACTION_PICK_IMAGES).apply {
                    type = photoMime
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    if (multiple) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, requireNotNull(limit))
                }
                // Direct starts avoid package-visibility queries; absent/blocked system pickers fall back.
                if (launchFileChooser(photo, request.requestCode)) return true
            }
        }
        val document = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            type = if (mimeTypes.size == 1) mimeTypes.single() else "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        if (!launchFileChooser(document, request.requestCode)) {
            webFileChooser.take(request.requestCode)?.let {
                respondToFileChooser(it.callback, null)
                if (isCurrentFileChooser(it.owner)) toastError(R.string.file_picker_unavailable)
            }
        }
        // Claimed or explicitly cancelled; WebView must not settle the same callback again.
        return true
    }

    private fun launchFileChooser(intent: Intent, requestCode: Int): Boolean = try {
        startActivityForResult(intent, requestCode)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        // A fallback still uses its own system provider and permission checks; it grants no bypass.
        false
    }

    private fun isCurrentFileChooser(owner: WebFileChooserOwner<WebView>): Boolean {
        val origin = gatewayOrigin ?: return false
        return !fileChooserTransitions.active && owner.matches(webView, origin.serialized, fileChooserDocument) && !isFinishing && !isDestroyed &&
            GatewayUrlPolicy.isSameOrigin(origin, owner.browser.url.orEmpty())
    }

    private fun respondToFileChooser(callback: ValueCallback<Array<Uri>>, values: Array<Uri>?) {
        // Chromium can withdraw its callback during renderer teardown; cancellation must not crash the Activity.
        runCatching { callback.onReceiveValue(values) }
    }

    private fun cancelWebFileChooser() {
        webFileChooser.cancel()?.let { respondToFileChooser(it.callback, null) }
    }

    private fun invalidateWebFileChooser() {
        fileChooserDocument += 1
        cancelWebFileChooser()
    }

    private fun finishFileSelection(requestCode: Int, resultCode: Int, data: Intent?) {
        val pending = webFileChooser.take(requestCode) ?: return
        if (!isCurrentFileChooser(pending.owner) || resultCode != RESULT_OK) {
            respondToFileChooser(pending.callback, null)
            return
        }
        val clipItems = data?.clipData?.let { clip: ClipData ->
            (0 until clip.itemCount).map { clip.getItemAt(it).uri }
        }.orEmpty()
        val uris = mergeFileChooserItems(clipItems, data?.data)
        respondToFileChooser(pending.callback, uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    private fun requestDownload(
        origin: GatewayOrigin,
        caCertificate: ByteArray?,
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        if (!GatewayUrlPolicy.isAllowedDownload(origin, url)) {
            toastError(R.string.download_blocked)
            return
        }
        val safeMime = mimeType?.substringBefore(';')?.trim()?.takeIf { MIME_TYPE.matches(it) }
            ?: "application/octet-stream"
        val guessed = android.webkit.URLUtil.guessFileName(url, contentDisposition, safeMime)
        pendingDownload = PendingDownload(
            origin = origin.serialized,
            url = url,
            userAgent = userAgent?.take(1_024),
            mimeType = safeMime,
            filename = sanitizeFilename(guessed),
            caCertificate = caCertificate?.copyOf(),
        )
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = safeMime
            putExtra(Intent.EXTRA_TITLE, pendingDownload?.filename)
        }
        try {
            startActivityForResult(
                Intent.createChooser(intent, getString(R.string.choose_download_destination)),
                DOWNLOAD_DESTINATION_REQUEST,
            )
        } catch (_: ActivityNotFoundException) {
            pendingDownload = null
            toastError(R.string.download_failed)
        }
    }

    private fun finishDownloadSelection(resultCode: Int, data: Intent?) {
        val request = pendingDownload ?: return
        pendingDownload = null
        val destination = data?.data
        val origin = GatewayOrigin.parse(request.origin)
        if (resultCode != RESULT_OK || destination == null || origin == null) return
        val cookieHeader = CookieManager.getInstance().getCookie(request.url)
        toast(R.string.download_in_progress)
        try {
            ioExecutor.execute {
                var temporary: File? = null
                try {
                    val downloaded = File.createTempFile("dsh-download-", ".tmp", cacheDir)
                    temporary = downloaded
                    FileOutputStream(downloaded).use { output ->
                        SameOriginDownloader.download(
                            origin,
                            request.url,
                            request.userAgent,
                            cookieHeader,
                            request.caCertificate,
                            output,
                        )
                    }
                    contentResolver.openOutputStream(destination, "w")?.use { output ->
                        downloaded.inputStream().use { input -> input.copyTo(output, DEFAULT_BUFFER_SIZE) }
                    } ?: error("The selected destination cannot be written")
                    runOnUiThread { toast(R.string.download_complete) }
                } catch (_: Exception) {
                    runOnUiThread { toastError(R.string.download_failed) }
                } finally {
                    temporary?.delete()
                }
            }
        } catch (_: RejectedExecutionException) {
            toastError(R.string.download_failed)
        }
    }

    private fun confirmClearSiteData() {
        AlertDialog.Builder(this)
            .setTitle(R.string.clear_site_data_title)
            .setMessage(R.string.clear_site_data_message)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.clear) { _, _ -> clearSiteData() }
            .show()
    }

    private fun clearSiteData() {
        if (withCredentialStorage {
                lanCredentialStore.clear()
                remoteCredentialStore.clear()
                pairedDeviceStore.clear()
            } == null) return
        webView?.apply {
            stopLoading()
            clearHistory()
            clearCache(true)
            clearSslPreferences()
        }
        WebStorage.getInstance().deleteAllData()
        WebViewDatabase.getInstance(this).apply {
            clearHttpAuthUsernamePassword()
        }
        WebView.clearClientCertPreferences(null)
        preferences.edit().clear().apply()
        CookieManager.getInstance().removeAllCookies {
            CookieManager.getInstance().flush()
            if (!isFinishing && !isDestroyed) runOnUiThread { showConnectionCenter() }
        }
    }

    private fun shareGateway(origin: GatewayOrigin) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, origin.serialized)
        }
        startActivity(Intent.createChooser(intent, getString(R.string.share_gateway_title)))
    }

    private fun openExternal(uri: Uri) {
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            toastError(R.string.no_browser)
        }
    }

    /** Only the live initial page uses the connection owner's single nonrenewable loading budget. */
    private fun initialPageLoadPending(): Boolean {
        val attempt = loadingConnectionAttempt ?: return false
        return pendingConnection === attempt && connectionAttempts.isCurrent(attempt)
    }

    private fun showLoadFailure(failure: LoadFailure) {
        if (isFinishing || failureDialog?.isShowing == true) return
        if (shouldAutomaticallyRecoverPage(failure, initialPageLoadPending())
            && canRecoverAutomatically()
        ) {
            if (scheduleAutomaticRecovery()) return
        }
        finishConnectionAttempt()
        val cpolarAddressFailure = isCpolarAddressFailure(failure, accessMode, gatewayOrigin)
        val (title, message) = if (cpolarAddressFailure) {
            R.string.cpolar_address_unreachable to R.string.cpolar_address_unreachable_message
        } else {
            when (failure) {
                LoadFailure.TLS -> R.string.secure_connection_failed to R.string.secure_connection_failed_message
                LoadFailure.AUTH_EXPIRED -> R.string.session_expired to R.string.session_expired_message
                LoadFailure.RATE_LIMITED -> R.string.remote_rate_limited to R.string.remote_rate_limited_message
                LoadFailure.SERVICE_UNAVAILABLE -> R.string.dsh_unavailable to R.string.dsh_unavailable_message
                LoadFailure.NETWORK -> if (accessMode == AccessMode.REMOTE) {
                    R.string.remote_unreachable to R.string.remote_unreachable_message
                } else {
                    R.string.page_load_failed to R.string.page_load_failed_message
                }
            }
        }
        failureDialog = AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton(R.string.retry) { _, _ ->
                recoveryStoppedBrowser = null
                if ((failure == LoadFailure.NETWORK || failure == LoadFailure.AUTH_EXPIRED || failure == LoadFailure.SERVICE_UNAVAILABLE)
                    && canRecoverAutomatically()
                ) {
                    recoverAutomatically()
                } else {
                    val target = retryUrl ?: gatewayOrigin?.serialized
                    if (target != null) {
                        startConnectionAttempt(accessMode)
                        loadingConnectionAttempt = pendingConnection
                        cancelWebFileChooser()
                        webView?.loadUrl(target)
                    }
                }
            }
            .setNegativeButton(R.string.edit_connection) { _, _ ->
                if (cpolarAddressFailure) showRemoteSetup() else showConnectionCenter()
            }
            .create()
            .also { dialog ->
                dialog.setOnDismissListener { failureDialog = null }
                dialog.show()
            }
    }

    private fun destroyWebView(changingConfigurations: Boolean = false, rendererGone: Boolean = false) {
        stopIrohStatusMonitor()
        cancelPageSessionRenewal()
        invalidateWebFileChooser()
        cancelPendingWebBack()
        secureWebViewClient?.dispose()
        secureWebViewClient = null
        pendingAudioPermission = null
        audioCaptureGrantedBrowser = null
        nativeBridge?.dispose(changingConfigurations)
        nativeBridge = null
        webView?.apply {
            fileChooserNavigationListener?.let { androidx.webkit.WebViewCompat.removeNavigationListener(this, it) }
            fileChooserNavigationListener = null
            fileChooserTransitions.clear()
            if (!rendererGone) {
                stopLoading()
                webChromeClient = null
                webViewClient = android.webkit.WebViewClient()
            }
            (parent as? ViewGroup)?.removeView(this)
            if (!rendererGone) removeAllViews()
            destroy()
        }
        webView = null
        loadingConnectionAttempt = null
        loadingDocumentGeneration = null
        recoveryStoppedBrowser = null
    }

    private fun textView(
        textResource: Int,
        sizeSp: Float,
        style: Int,
        colorResource: Int = R.color.app_foreground,
    ): TextView = TextView(this).apply {
        setText(textResource)
        textSize = sizeSp
        setTypeface(Typeface.DEFAULT, style)
        setTextColor(getColor(colorResource))
    }

    private fun toolbarIconButton(iconResource: Int, labelResource: Int): ImageButton = ImageButton(this).apply {
        setImageResource(iconResource)
        contentDescription = getString(labelResource)
        setColorFilter(getColor(R.color.app_foreground))
        scaleType = ImageView.ScaleType.CENTER
        setPadding(dp(8), dp(8), dp(8), dp(8))
        val selectable = TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, selectable, true)
        setBackgroundResource(selectable.resourceId)
    }

    /** Primary action button: accent fill, consistent tap target. */
    private fun primaryButton(textResource: Int, minHeightDp: Int, onClick: Button.() -> Unit): Button = Button(this).apply {
        setText(textResource)
        isAllCaps = false
        textSize = 17f
        setTypeface(Typeface.DEFAULT, Typeface.BOLD)
        minHeight = dp(minHeightDp)
        backgroundTintList = null
        background = roundedRipple(getColor(R.color.app_accent), 16)
        setTextColor(getColor(R.color.app_on_accent))
        setOnClickListener { onClick() }
    }

    /** Secondary action button: tinted fill, quieter than the primary one. */
    private fun secondaryButton(textResource: Int, minHeightDp: Int, onClick: Button.() -> Unit): Button = Button(this).apply {
        setText(textResource)
        isAllCaps = false
        textSize = 15f
        minHeight = dp(minHeightDp)
        setTextColor(getColor(R.color.app_foreground))
        backgroundTintList = null
        background = roundedRipple(getColor(R.color.app_surface_tinted), 12)
        setOnClickListener { onClick() }
    }

    /** Filled text field: tinted rounded background with comfortable padding. */
    private fun field(
        hintResource: Int,
        inputType: Int,
        imeOptions: Int,
        minHeightDp: Int,
        contentDescriptionResource: Int,
    ): EditText = EditText(this).apply {
        hint = getString(hintResource)
        this.inputType = inputType
        this.imeOptions = imeOptions
        isSingleLine = true
        minHeight = dp(minHeightDp)
        textSize = 16f
        setPadding(dp(16), 0, dp(16), 0)
        background = roundedSurface(getColor(R.color.app_surface_tinted), 12)
        this.contentDescription = getString(contentDescriptionResource)
    }

    private fun roundedSurface(color: Int, radiusDp: Int): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
    }

    private fun roundedRipple(color: Int, radiusDp: Int): RippleDrawable {
        val content = roundedSurface(color, radiusDp)
        return RippleDrawable(
            ColorStateList.valueOf(getColor(R.color.app_border)),
            content,
            null,
        )
    }

    private fun spacer(heightDp: Int): View = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(1, dp(heightDp))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    private fun acceptedMimeTypes(rawTypes: Array<String>): List<String> = rawTypes
        .flatMap { it.split(',') }
        .map { it.trim().lowercase() }
        .mapNotNull { value ->
            when {
                MIME_TYPE.matches(value) -> value
                value.startsWith('.') -> MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(value.removePrefix("."))
                else -> null
            }
        }
        .distinct()
        .ifEmpty { listOf("*/*") }

    private fun sanitizeFilename(rawName: String): String {
        val sanitized = rawName
            .replace(UNSAFE_FILENAME, "_")
            .trim(' ', '.')
            .take(128)
        return sanitized.ifEmpty { "dsh-download" }
    }

    private fun toast(textResource: Int) {
        Toast.makeText(this, textResource, Toast.LENGTH_SHORT).show()
    }

    private fun toastError(textResource: Int) {
        Toast.makeText(this, textResource, Toast.LENGTH_LONG).show()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val PREFERENCES_NAME = "dsh_mobile"
        const val PREFERENCE_LAN_ORIGIN = "gateway_origin"
        const val PREFERENCE_REMOTE_ORIGIN = "remote_gateway_origin"
        const val PREFERENCE_LAST_ACCESS_MODE = "last_access_mode"
        const val PREFERENCE_LAST_DEVICE_KEY = "last_device_key"
        const val PREFERENCE_LAST_CONNECTED_LAN = "last_connected_lan"
        const val PREFERENCE_LAST_CONNECTED_REMOTE = "last_connected_remote"
        const val PREFERENCE_LAUNCH_BEHAVIOR = "launch_behavior"
        const val PREFERENCE_NEARBY_PERMISSION_LIMITED = "nearby_permission_limited"
        const val PREFERENCE_NOTIFICATION_PERMISSION_REQUESTED = "notification_permission_requested"
        const val PREFERENCE_WEB_CHROME_COLOR = "web_chrome_color"
        const val PREFERENCE_APP_ICON = "app_icon"
        const val STATE_SHOWING_SETUP = "showing_setup"
        const val STATE_ACCESS_MODE = "access_mode"
        const val STATE_NATIVE_BRIDGE = "native_bridge"
        const val STATE_DEFERRED_BRIDGE_REQUEST = "deferred_bridge_request"
        const val STATE_DEFERRED_BRIDGE_RESULT = "deferred_bridge_result"
        const val STATE_DEFERRED_BRIDGE_DATA = "deferred_bridge_data"
        const val STATE_DEFERRED_BRIDGE_PERMISSION = "deferred_bridge_permission"
        const val STATE_PENDING_DOWNLOAD = "pending_download"
        private const val STATE_NEXT_FILE_CHOOSER_CODE = "next_file_chooser_request_code"
        private val webFileChooserRequestCodes = WebFileChooserRequestCodes()
        const val DOWNLOAD_DESTINATION_REQUEST = 4102
        const val SCAN_CAMERA_REQUEST = 4103
        const val NEARBY_WIFI_REQUEST = 4104
        const val TASK_NOTIFICATION_PERMISSION_REQUEST = 4105
        const val SCAN_QR_REQUEST = 4106
        const val VOICE_PERMISSION_REQUEST = 4107
        const val DEVICE_STATUS_REFRESH_MS = 20_000L
        const val IROH_STATUS_POLL_MS = 2_000L
        const val DEVICE_UNDO_TIMEOUT_MS = 6_000L
        const val LIVE_DOCUMENT_PROBE_TIMEOUT_MS = 2_000L
        const val MOBILE_BACK_TIMEOUT_MS = 1_500L
        const val PAGE_READY_POLL_MS = 250L
        const val LAN_CONNECTION_BUDGET_MS = 30_000L
        const val REMOTE_CONNECTION_BUDGET_MS = 60_000L
        const val APP_RELEASES_URL = "https://github.com/saya-ch/dsh-mobile/releases/latest"
        val RECOVERY_DELAYS_MS = longArrayOf(0L, 1_000L, 3_000L, 8_000L)
        val MIME_TYPE = Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+*-]+$")
        val UNSAFE_FILENAME = Regex("[\\\\/:*?\"<>|\\p{Cc}]")
    }
}
