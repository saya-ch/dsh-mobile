package io.github.sayach.dshmobile

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.app.PictureInPictureParams
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Shader
import android.animation.ValueAnimator
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.StateListDrawable
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
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.view.animation.DecelerateInterpolator
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
import android.widget.BaseAdapter
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
    // Boot batches are content-revisioned, so the store outlives every WebView; each WebView owns
    // one cache (and its bounded worker) which destroyWebView closes.
    private val bootAssetStore by lazy { BootAssetStore(File(filesDir, "boot-assets")) }
    private var bootAssetCache: BootAssetCache? = null
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
    /** Set while the activity is being sent to picture-in-picture, so onPause keeps the page live. */
    private var pictureInPictureRequested = false
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
    private var displayScale: NativeDisplayScale? = null
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
    private var pendingNotificationNavigate: String? = null
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

    /**
     * Resolve the palette before any view is inflated: an explicit light or dark choice
     * overrides the system configuration, and following the system needs no wrapper.
     */
    override fun attachBaseContext(newBase: Context) {
        val stored = newBase.getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
            .getString(ThemePreference.KEY, null)
        super.attachBaseContext(ThemePreference.wrap(newBase, ThemePreference.sanitize(stored)))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        savedInstanceState?.getInt(STATE_NEXT_FILE_CHOOSER_CODE)?.let(webFileChooserRequestCodes::restoreAtLeast)
        cleanupStaleDownloadFiles(cacheDir)
        configureEdgeToEdgeWindow(window)
        applyStatusBarIconContrast(window, getColor(R.color.app_background))
        nearbyPermissionLimited = preferences.getBoolean(PREFERENCE_NEARBY_PERMISSION_LIMITED, false)
        migrateLegacyDeviceSlots()
        pendingNotificationNavigate = NativeBridgePolicy.sanitizeNotificationNavigate(
            intent.getStringExtra(NativeBridgePolicy.EXTRA_NOTIFICATION_NAVIGATE).orEmpty(),
        ).ifEmpty { null }
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
        // A palette change recreates the Activity; land back on the screen that offered it.
        // A cold start has no saved state, so a marker left by a killed process can never
        // take precedence over the normal launch path and its automatic recovery.
        val reopenSettings = savedInstanceState != null && intent.getBooleanExtra(EXTRA_REOPEN_SETTINGS, false)
        if (reopenSettings) intent.removeExtra(EXTRA_REOPEN_SETTINGS)
        when {
            reopenSettings -> showSettings(animate = false)
            savedInstanceState?.getBoolean(STATE_SHOWING_SETUP) == true -> showConnectionCenter()
            else -> restoreColdStartConnection(
                restoredMode ?: AccessMode.parse(preferences.getString(PREFERENCE_LAST_ACCESS_MODE, null)),
            )
        }
    }

    /**
     * A task-notification tap can arrive while the app is already foregrounded. Route it to the
     * same pending-navigate path used at cold start (see showBrowser), so the page lands on the
     * exact conversation the notification referred to.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val navigate = NativeBridgePolicy.sanitizeNotificationNavigate(
            intent.getStringExtra(NativeBridgePolicy.EXTRA_NOTIFICATION_NAVIGATE).orEmpty(),
        ).ifEmpty { return }
        pendingNotificationNavigate = navigate
        val origin = gatewayOrigin
        val browser = webView
        if (origin != null && browser != null && !isFinishing) {
            val full = origin.serialized.trimEnd('/') + navigate
            if (GatewayUrlPolicy.isSameOrigin(origin, full)) {
                // A live page can open the Session in place; only a page that cannot handle the
                // route is reloaded with it. Reloading discarded drafts, scroll and other Sessions.
                val script = "window.__dshMobileOpenSession && window.__dshMobileOpenSession(" +
                    org.json.JSONObject.quote(navigate) + ")"
                browser.evaluateJavascript(script) { result ->
                    val handled = result == "true"
                    if (webView !== browser || isFinishing) return@evaluateJavascript
                    if (!handled) browser.loadUrl(full)
                    pendingNotificationNavigate = null
                }
            }
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
        // A dismissed or expanded floating window must not leave the page marked live.
        if (!isInPictureInPictureMode) pictureInPictureRequested = false
        sameHostGate.resume()
        sameHostMonitor.start()
        nativeBridge?.onHostResumed()
        webView?.onResume()
        window.decorView.requestApplyInsets()
        if (deviceListVisible && showingSetup) refreshDeviceStatuses(pairedDeviceStore.load())
        startIrohStatusMonitor()
        // An opt-in kept through a temporary stop (a package replacement, a background-start
        // restriction, a spent foreground budget) is retried when the user is back in the app,
        // so the feature recovers without another package launch and without toggling it (#442).
        activeDeviceKey?.let { key ->
            runCatching { BackgroundNotificationService.resumeIfEnabled(this, key) }
        }
    }

    /** Leaving for the home screen floats the DSH page when the user asked for it. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (!PictureInPicturePolicy.shouldEnter(
                enabled = pictureInPictureEnabled(),
                browserPageVisible = browserPageVisible(),
                sdkInt = Build.VERSION.SDK_INT,
                finishingOrDestroyed = isFinishing || isDestroyed,
                alreadyInPictureInPicture = isInPictureInPictureMode,
            )
        ) return
        val browser = webView ?: return
        val (width, height) = PictureInPicturePolicy.aspectRatio(browser.width, browser.height)
        val params = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(width, height))
            .build()
        pictureInPictureRequested = runCatching { enterPictureInPictureMode(params) }.getOrDefault(false)
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        // The floating window is a small copy of the page: keep the full-screen layout and scale
        // it down, so a fixed-size widget holds its corner instead of filling the window.
        displayScale?.setFloating(isInPictureInPictureMode)
        if (isInPictureInPictureMode) return
        // Returning to full screen: restore the page the paused window left behind.
        pictureInPictureRequested = false
        webView?.onResume()
    }

    override fun onPause() {
        dismissActiveSheet()
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
        // A floating window must keep drawing the page; only a real background pause stops it.
        if (!pictureInPictureRequested && !isInPictureInPictureMode) webView?.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        cancelBackdropAnimators()
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
        // A sheet held across a pause would survive this instance and leak its window.
        activeSheet?.takeIf { it.isShowing }?.dismiss()
        activeSheet = null
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
        deviceListStatus?.apply {
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
            background = screenBackground()
            addMistBackdrop(this)
            addGridBackdrop(this)
            isClickable = true
            isFocusableInTouchMode = true
            accessibilityPaneTitle = message
            // Receive unconsumed Insets before the real page while still drawing above it.
            translationZ = dp(1).toFloat()
        }
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
                textSize = UiTokens.bodySp
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

    /** Depth of the screen on show; a deeper screen enters from the right, a shallower one from the left. */
    private var pageDepth = 0

    /** Background animators currently attached to a live screen. */
    private val backdropAnimators = mutableListOf<ValueAnimator>()

    /**
     * Starts a backdrop animator and ties its life to the view it moves: an infinite
     * ValueAnimator is held by the UI thread's animation handler, so without this it
     * outlives the screen and drags the Activity with it.
     */
    private fun trackBackdrop(animator: ValueAnimator, view: View) {
        view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {
                if (!animator.isStarted && ValueAnimator.areAnimatorsEnabled()) {
                    animator.start()
                    if (!backdropAnimators.contains(animator)) backdropAnimators += animator
                }
            }

            override fun onViewDetachedFromWindow(v: View) {
                animator.cancel()
                backdropAnimators -= animator
            }
        })
        if (ValueAnimator.areAnimatorsEnabled()) {
            animator.start()
            backdropAnimators += animator
        }
    }

    private fun cancelBackdropAnimators() {
        backdropAnimators.forEach { it.cancel() }
        backdropAnimators.clear()
    }

    /** The one sheet currently on screen; it must not survive an Activity teardown. */
    private var activeSheet: Dialog? = null
    private var activeSheetDismissOnPause = true
    private var pairingOrigin: (() -> Unit)? = null
    private var pendingPairingFailure: Int? = null

    private fun dismissActiveSheet() {
        val sheet = activeSheet ?: return
        if (!activeSheetDismissOnPause) return
        dismissSheet(sheet)
        activeSheet = null
        activeSheetDismissOnPause = true
    }

    private fun setPageContent(root: View, depth: Int = pageDepth.coerceAtLeast(0), animate: Boolean = true) {
        detachConnectionWaitingView()
        cancelBackdropAnimators()
        setContentView(root)
        attachConnectionWaitingView()
        if (animate) playPageTransition(root, depth) else pageDepth = depth
    }

    /**
     * A short slide toward the reading direction. The animation is skipped when the
     * system reports animations off, so a reduced-motion setting keeps pages instant.
     */
    private fun playPageTransition(root: View, depth: Int) {
        if (!android.animation.ValueAnimator.areAnimatorsEnabled()) {
            pageDepth = depth
            return
        }
        val forward = depth > pageDepth
        pageDepth = depth
        root.translationX = (if (forward) dp(26) else -dp(18)).toFloat()
        root.alpha = 0.88f
        root.animate()
            .translationX(0f)
            .alpha(1f)
            .setDuration(if (forward) 240L else 200L)
            .setInterpolator(DecelerateInterpolator())
            .start()
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
        showDeviceList()
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

        val screen = createSetupScreen(R.string.paired_devices_title, R.string.paired_devices_description, depth = 0)
        deviceListStatus = screen.subtitle?.apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        screen.header.addView(
            toolbarIconButton(R.drawable.ic_settings, R.string.device_list_settings).apply {
                setOnClickListener { showSettings() }
            },
            LinearLayout.LayoutParams(dp(48), dp(48)),
        )
        val devices = pairedDeviceStore.load()
        if (devices.isEmpty()) {
            // First-use empty state: a compact illustration, the reason the list is
            // empty, and one action that changes it. No placeholder list.
            val empty = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(dp(UiTokens.gapSm), 0, dp(UiTokens.gapSm), 0)
                addView(
                    TextView(this@MainActivity).apply {
                        setText(R.string.paired_devices_empty_title)
                        textSize = UiTokens.displaySp
                        setTypeface(Typeface.DEFAULT, Typeface.BOLD)
                        setTextColor(getColor(R.color.app_foreground))
                        gravity = Gravity.CENTER
                    },
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ),
                )
                addView(
                    TextView(this@MainActivity).apply {
                        setText(R.string.paired_devices_empty)
                        textSize = 13f
                        setTextColor(getColor(R.color.app_secondary))
                        gravity = Gravity.CENTER
                        setLineSpacing(dp(3).toFloat(), 1f)
                    },
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(8) },
                )
                addView(
                    primaryButton(R.string.add_computer, 48) { showAddComputerSheet() },
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(22) },
                )
            }
            screen.content.addView(
                empty,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
        } else {
            val group = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                background = glassSurface(R.color.app_surface, UiTokens.cardRadius)
                setPadding(dp(4), dp(4), dp(4), dp(4))
            }
            devices.forEachIndexed { index, device ->
                if (index > 0) {
                    group.addView(
                        fadingDivider(),
                        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)).apply {
                            leftMargin = dp(16)
                            rightMargin = dp(16)
                        },
                    )
                }
                group.addView(
                    deviceRow(device),
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ),
                )
            }
            screen.content.addView(
                group,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
            addAddComputerAction(screen)
        }
        refreshDeviceStatuses(devices)
    }

    /**
     * Settings page: two labelled groups, each row carrying an icon, the current
     * value and a chevron, so the user reads state without opening anything.
     */
    private fun showSettings(animate: Boolean = true) {
        deviceListStatus = null
        deviceListVisible = false
        stopDeviceListRefresh()
        val screen = createSetupScreen(
            R.string.device_list_settings,
            back = ::showDeviceList,
            depth = 1,
            animate = animate,
        )
        setupBackAction = ::showDeviceList

        val launchValue = getString(
            if (launchBehavior() == LaunchBehavior.DEVICE_LIST) R.string.launch_device_list else R.string.launch_direct_dsh,
        )
        val iconValue = getString(iconShortLabelResource(currentAppIcon()))
        val sameHostValue = getString(
            when (sameHostMode()) {
                SameHostSwitchMode.MANUAL -> R.string.same_host_manual
                SameHostSwitchMode.CONFIRM -> R.string.same_host_detect
                else -> R.string.same_host_enable
            },
        )

        val group = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassSurface(R.color.app_card_fill, UiTokens.cardRadius)
        }
        fun divider() = group.addView(
            fadingDivider(),
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)).apply {
                leftMargin = dp(66)
                rightMargin = dp(UiTokens.gapLg)
            },
        )
        group.addView(settingsRow(R.drawable.ic_launch, R.string.launch_settings, launchValue) { showLaunchSettings() })
        divider()
        group.addView(
            settingsRow(R.drawable.ic_brightness, R.string.theme_title, getString(themeLabelResource(themeMode()))) {
                showThemeSettings()
            },
        )
        divider()
        group.addView(settingsRow(R.drawable.ic_palette, R.string.icon_settings, iconValue) { showIconSettings() })
        divider()
        group.addView(settingsRow(R.drawable.ic_sync, R.string.same_host_title, sameHostValue) { showSameHostSettings() })
        divider()
        group.addView(
            settingsRow(
                R.drawable.ic_picture_in_picture,
                R.string.picture_in_picture_title,
                getString(pictureInPictureLabelResource()),
            ) { showPictureInPictureSettings() },
        )
        divider()
        group.addView(
            settingsRow(R.drawable.ic_refresh, R.string.check_for_updates, "v" + BuildConfig.VERSION_NAME) { checkForAppUpdate() },
        )
        screen.content.addView(group, fullWidth())

        // Destructive and rare, so it sits apart from the switches that are used often.
        val dangerGroup = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassSurface(R.color.app_card_fill, UiTokens.cardRadius)
        }
        dangerGroup.addView(
            settingsRow(R.drawable.ic_delete, R.string.clear_site_data, danger = true) { confirmClearSiteData() },
        )
        screen.content.addView(dangerGroup, fullWidth().apply { topMargin = dp(UiTokens.gapLg) })
    }

    /** The DSH page is on screen, so a floating window would show something real. */
    private fun browserPageVisible(): Boolean =
        webView != null && !deviceListVisible && !showingSetup && !isFinishing && !isDestroyed

    private fun pictureInPictureEnabled(): Boolean =
        preferences.getBoolean(PREFERENCE_PICTURE_IN_PICTURE, false)

    private fun pictureInPictureLabelResource(): Int =
        if (pictureInPictureEnabled()) R.string.picture_in_picture_on else R.string.picture_in_picture_off

    /**
     * Toggles the floating window. Android 12+ also honours an automatic entry, which
     * this activity opts into through the manifest flag and [onUserLeaveHint].
     */
    private fun showPictureInPictureSettings() {
        showChoiceSheet(
            getString(R.string.picture_in_picture_title),
            listOf(getString(R.string.picture_in_picture_off), getString(R.string.picture_in_picture_on)),
            if (pictureInPictureEnabled()) 1 else 0,
        ) { which ->
            preferences.edit().putBoolean(PREFERENCE_PICTURE_IN_PICTURE, which == 1).apply()
        }
    }

    /** The palette currently in force: an explicit choice, otherwise the system's. */
    private fun themeMode(): String = ThemePreference.sanitize(preferences.getString(ThemePreference.KEY, null))

    private fun themeLabelResource(mode: String): Int = when (ThemePreference.sanitize(mode)) {
        ThemePreference.LIGHT -> R.string.theme_light
        ThemePreference.DARK -> R.string.theme_dark
        else -> R.string.theme_follow_system
    }

    private fun showThemeSettings() {
        val modes = listOf(ThemePreference.SYSTEM, ThemePreference.LIGHT, ThemePreference.DARK)
        showChoiceSheet(
            getString(R.string.theme_title),
            modes.map { getString(themeLabelResource(it)) },
            modes.indexOf(themeMode()).coerceAtLeast(0),
        ) { which -> applyThemeMode(modes[which]) }
    }

    /**
     * The palette is resolved from the configuration before the first view exists, so a
     * change recreates the Activity; the flag brings the user back to this page instead
     * of the device list they did not ask for.
     */
    private fun applyThemeMode(mode: String) {
        val sanitized = ThemePreference.sanitize(mode)
        if (sanitized == themeMode()) return
        preferences.edit().putString(ThemePreference.KEY, sanitized).apply()
        intent.putExtra(EXTRA_REOPEN_SETTINGS, true)
        recreate()
    }

    /** Destructive and irreversible from inside the app, so it asks once. */
    private fun confirmClearSiteData() {
        showBottomSheet(getString(R.string.clear_site_data_title)) { sheet, dialog ->
            sheet.addView(
                TextView(this).apply {
                    setText(R.string.clear_site_data_message)
                    textSize = UiTokens.bodySp
                    setTextColor(getColor(R.color.app_secondary))
                },
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(UiTokens.gapLg) },
            )
            sheet.addView(
                dangerButton(R.string.clear) {
                    dismissSheet(dialog)
                    clearSiteData()
                },
                fullWidth().apply { bottomMargin = dp(UiTokens.gapSm) },
            )
            sheet.addView(
                sheetRow(getString(R.string.cancel), onClick = { dismissSheet(dialog) }).apply {
                    setTextColor(getColor(R.color.app_secondary))
                },
                fullWidth(),
            )
        }
    }

    /**
     * Removes every trace of the current DSH session. The credential store goes
     * first: if it cannot be cleared nothing else is touched, because a half reset
     * would leave the app paired to a computer it no longer remembers.
     */
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
        // Site data and cached boot batches belong to the same session; clearing one clears both.
        clearBootAssetStore()
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

    /**
     * One settings entry. A row without a value is a plain action, so it drops the
     * trailing text and chevron instead of leaving an empty gap; [danger] recolours
     * the ink for the entries that destroy state.
     */
    private fun settingsRow(
        iconResource: Int,
        titleResource: Int,
        value: String = "",
        danger: Boolean = false,
        onClick: () -> Unit,
    ): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(58)
        setPadding(dp(UiTokens.gapLg), dp(UiTokens.gap), dp(UiTokens.gap), dp(UiTokens.gap))
        background = roundedRipple(Color.TRANSPARENT, 0)
        isClickable = true
        isFocusable = true
        contentDescription = if (value.isEmpty()) {
            getString(titleResource)
        } else {
            getString(R.string.settings_row_accessibility, getString(titleResource), value)
        }
        addView(
            ImageView(this@MainActivity).apply {
                setImageResource(iconResource)
                setColorFilter(getColor(if (danger) R.color.app_error else R.color.app_on_accent_container))
                setPadding(dp(9), dp(9), dp(9), dp(9))
                // A destructive row keeps the outline of the others but not their accent fill.
                background = if (danger) {
                    null
                } else {
                    roundedSurface(getColor(R.color.app_accent_container), UiTokens.iconRadius).apply {
                        setStroke(dp(1), getColor(R.color.app_border))
                    }
                }
                contentDescription = null
            },
            LinearLayout.LayoutParams(dp(38), dp(38)).apply { rightMargin = dp(UiTokens.gap) },
        )
        addView(
            TextView(this@MainActivity).apply {
                setText(titleResource)
                textSize = UiTokens.itemTitleSp
                setTextColor(getColor(if (danger) R.color.app_error else R.color.app_foreground))
                maxLines = 1
            },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT),
        )
        if (value.isNotEmpty()) {
            addView(
                TextView(this@MainActivity).apply {
                    text = value
                    textSize = UiTokens.captionSp
                    setTextColor(getColor(R.color.app_secondary))
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                    gravity = Gravity.END
                },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginStart = dp(UiTokens.gapSm)
                },
            )
            addView(
                ImageView(this@MainActivity).apply {
                    setImageResource(R.drawable.ic_chevron_right)
                    setColorFilter(getColor(R.color.app_secondary))
                    contentDescription = null
                },
                LinearLayout.LayoutParams(dp(22), dp(22)).apply { leftMargin = dp(UiTokens.gapSm) },
            )
        }
        setOnClickListener { onClick() }
    }

    /** Bottom action that opens the add-computer sheet. */
    private fun addAddComputerAction(screen: SetupScreen) {
        val main = screenAction(R.string.add_computer) { }
        main.setOnClickListener { showAddComputerSheet() }
        screen.root.addView(
            main,
            FrameLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            ).apply {
                leftMargin = dp(UiTokens.screenPadding)
                rightMargin = dp(UiTokens.screenPadding)
                bottomMargin = dp(20)
            },
        )
    }

    /**
     * Shared bottom sheet: scrim, rounded card, grabber and an optional title.
     * Action lists and small forms all build on it, so a menu never falls back to
     * the platform dialog chrome.
     */
    private fun showBottomSheet(
        title: CharSequence?,
        dismissOnPause: Boolean = true,
        onDismiss: (() -> Unit)? = null,
        build: (LinearLayout, Dialog) -> Unit,
    ): Dialog {
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(UiTokens.screenPadding), dp(10), dp(UiTokens.screenPadding), dp(UiTokens.cardRadius))
            background = roundedSurface(getColor(R.color.app_dialog_surface), UiTokens.cardRadius).apply {
                setStroke(dp(1), getColor(R.color.app_border))
            }
        }
        sheet.addView(
            View(this).apply { background = roundedSurface(getColor(R.color.app_border), 999) },
            LinearLayout.LayoutParams(dp(36), dp(4)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                bottomMargin = dp(UiTokens.gap)
            },
        )
        if (title != null) {
            sheet.addView(
                TextView(this).apply {
                    text = title
                    textSize = UiTokens.headerSp
                    setTypeface(Typeface.DEFAULT, Typeface.BOLD)
                    setTextColor(getColor(R.color.app_foreground))
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(UiTokens.gap) },
            )
        }
        // A long list must scroll instead of running off a short screen.
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply {
            isFillViewport = false
            clipToPadding = false
            addView(
                body,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
        sheet.addView(
            scroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        val dialog = Dialog(this).apply {
            requestWindowFeature(Window.FEATURE_NO_TITLE)
            setContentView(sheet)
            setCanceledOnTouchOutside(true)
        }
        build(body, dialog)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.BOTTOM)
            setDimAmount(0.42f)
            setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        if (title != null) dialog.window?.decorView?.accessibilityPaneTitle = title
        if (isFinishing || isDestroyed) return dialog
        dialog.setOnDismissListener {
            if (activeSheet === dialog) {
                activeSheet = null
                activeSheetDismissOnPause = true
            }
            onDismiss?.invoke()
        }
        runCatching { dialog.show() }.onFailure { return dialog }
        activeSheet = dialog
        activeSheetDismissOnPause = dismissOnPause
        scroll.post {
            val cap = (resources.displayMetrics.heightPixels * 0.72f).toInt()
            if (scroll.height > cap) {
                scroll.layoutParams = scroll.layoutParams.apply { height = cap }
                scroll.requestLayout()
            }
        }
        return dialog
    }

    /** One row inside a sheet: label, optional chevron and an optional danger colour. */
    private fun sheetRow(
        label: CharSequence,
        danger: Boolean = false,
        onClick: () -> Unit,
    ): TextView = TextView(this).apply {
        text = label
        textSize = UiTokens.itemTitleSp
        setTextColor(getColor(if (danger) R.color.app_error else R.color.app_foreground))
        gravity = Gravity.CENTER_VERTICAL
        minHeight = dp(48)
        setPadding(dp(UiTokens.gap), dp(UiTokens.bodySmallSp.toInt()), dp(UiTokens.gap), dp(UiTokens.bodySmallSp.toInt()))
        background = roundedRipple(Color.TRANSPARENT, UiTokens.iconRadius)
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    /** Action list rendered as a sheet; the last row is always Cancel. */
    private fun showActionSheet(
        title: CharSequence?,
        actions: List<Triple<String, Boolean, () -> Unit>>,
    ) {
        showBottomSheet(title) { sheet, dialog ->
            actions.forEach { action ->
                sheet.addView(
                    sheetRow(action.first, action.second) {
                        dismissSheet(dialog)
                        action.third()
                    },
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ),
                )
            }
            sheet.addView(
                sheetRow(getString(R.string.cancel), onClick = { dismissSheet(dialog) }).apply {
                    setTextColor(getColor(R.color.app_secondary))
                },
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
    }

    /** Check mark drawn as a tinted circle, so a selected row reads at a glance. */
    private fun selectionMark(): View = View(this).apply {
        background = roundedSurface(getColor(R.color.app_accent), 999)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /**
     * Single-choice sheet. A row may carry artwork (the icon picker needs it) and
     * the current entry is marked instead of relying on the platform radio list.
     */
    private fun showChoiceSheet(
        title: CharSequence,
        labels: List<String>,
        selected: Int,
        artwork: List<String>? = null,
        onPick: (Int) -> Unit,
    ) {
        showBottomSheet(title) { sheet, dialog ->
            labels.forEachIndexed { index, label ->
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(UiTokens.gap), dp(12), dp(UiTokens.gap), dp(12))
                    minimumHeight = dp(48)
                    background = roundedRipple(Color.TRANSPARENT, UiTokens.iconRadius)
                    isClickable = true
                    isFocusable = true
                    isSelected = index == selected
                    contentDescription = label
                }
                artwork?.getOrNull(index)?.let { name ->
                    val id = resources.getIdentifier(name, "mipmap", packageName)
                    if (id != 0) {
                        row.addView(
                            ImageView(this@MainActivity).apply {
                                setImageResource(id)
                                contentDescription = null
                                scaleType = ImageView.ScaleType.FIT_CENTER
                            },
                            LinearLayout.LayoutParams(dp(36), dp(36)).apply { rightMargin = dp(UiTokens.gap) },
                        )
                    }
                }
                val current = index == selected
                row.addView(
                    TextView(this@MainActivity).apply {
                        text = label
                        textSize = UiTokens.itemTitleSp
                        setTextColor(getColor(if (current) R.color.app_accent else R.color.app_foreground))
                        if (current) setTypeface(Typeface.DEFAULT, Typeface.BOLD)
                        maxLines = 1
                        ellipsize = TextUtils.TruncateAt.END
                    },
                    LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
                )
                if (current) {
                    row.addView(selectionMark(), LinearLayout.LayoutParams(dp(8), dp(8)).apply {
                        leftMargin = dp(UiTokens.gap)
                    })
                }
                row.setOnClickListener {
                    dismissSheet(dialog)
                    onPick(index)
                }
                sheet.addView(row, fullWidth())
            }
            sheet.addView(
                sheetRow(getString(R.string.cancel), onClick = { dismissSheet(dialog) }).apply {
                    setTextColor(getColor(R.color.app_secondary))
                },
                fullWidth(),
            )
        }
    }

    /** Destructive action styled like the primary one but in the error colour. */
    private fun dangerButton(textResource: Int, onClick: () -> Unit): TextView = TextView(this).apply {
        setText(textResource)
        textSize = UiTokens.buttonSp
        setTypeface(Typeface.DEFAULT, Typeface.BOLD)
        setTextColor(getColor(R.color.app_danger_text))
        gravity = Gravity.CENTER
        minHeight = dp(52)
        val sink = this
        stateListAnimator = android.animation.StateListAnimator().apply {
            addState(
                intArrayOf(android.R.attr.state_pressed),
                android.animation.ObjectAnimator.ofFloat(sink, "translationZ", dp(0).toFloat()),
            )
            addState(
                intArrayOf(),
                android.animation.ObjectAnimator.ofFloat(sink, "translationZ", dp(3).toFloat()),
            )
        }
        background = RippleDrawable(
            ColorStateList.valueOf(Color.TRANSPARENT),
            roundedSurface(getColor(R.color.app_danger_fill), UiTokens.controlRadius),
            null,
        )
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    /** Small helper for the sheets built around a single input field. */
    private fun sheetField(
        sheet: LinearLayout,
        hintResource: Int,
        contentDescriptionResource: Int,
        initial: String,
        inputType: Int,
    ): Pair<EditText, TextView> {
        val input = field(hintResource, inputType, EditorInfo.IME_ACTION_DONE, 56, contentDescriptionResource).apply {
            setText(initial)
            setSelection(initial.length)
        }
        val error = inlineError()
        onFieldEdited(input) { clearInlineError(input, error) }
        sheet.addView(input, fullWidth())
        sheet.addView(error, fullWidth())
        input.requestFocus()
        return input to error
    }

    /** Names follow one rule everywhere: 1-32 code units, no control characters. */
    private fun normalizedDeviceName(raw: String): String? {
        val name = java.text.Normalizer.normalize(raw, java.text.Normalizer.Form.NFC).trim()
        return name.takeIf { it.length in 1..32 && !Regex("[\u0000-\u001f\u007f]").containsMatchIn(it) }
    }

    /** Dismissing by reference keeps the sheet independent from its builder. */
    private fun dismissSheet(dialog: Dialog?) {
        dialog?.takeIf { it.isShowing }?.dismiss()
    }

    /**
     * Add-computer sheet: the three transports live in one bottom panel with its own
     * scrim, so the choice never floats loose in the middle of the screen.
     */
    /**
     * Add-computer sheet: the three transports live in the shared bottom sheet, so
     * the window chrome, animation and accessibility title cannot drift.
     */
    private fun showAddComputerSheet() {
        showBottomSheet(getString(R.string.add_computer)) { sheet, dialog ->
            val entries: List<Triple<Int, Int, () -> Unit>> = listOf(
                Triple(R.drawable.ic_lan, R.string.lan_access_title, { showSetup() }),
                Triple(R.drawable.ic_cloud, R.string.remote_access_title, { showRemoteSetup() }),
                Triple(R.drawable.ic_bolt, R.string.iroh_access_title, { showIrohSetup() }),
            )
            entries.forEach { entry ->
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    minimumHeight = dp(64)
                    setPadding(dp(UiTokens.gap), dp(10), dp(UiTokens.gap), dp(10))
                    background = roundedRipple(Color.TRANSPARENT, UiTokens.iconRadius)
                    isClickable = true
                    isFocusable = true
                    contentDescription = getString(entry.second)
                    addView(
                        ImageView(this@MainActivity).apply {
                            setImageResource(entry.first)
                            setColorFilter(getColor(R.color.app_on_accent_container))
                            setPadding(dp(10), dp(10), dp(10), dp(10))
                            background = roundedSurface(getColor(R.color.app_accent_container), 13)
                            contentDescription = null
                        },
                        LinearLayout.LayoutParams(dp(42), dp(42)).apply { rightMargin = dp(UiTokens.gap) },
                    )
                    addView(
                        TextView(this@MainActivity).apply {
                            setText(entry.second)
                            textSize = UiTokens.itemTitleSp
                            setTypeface(Typeface.DEFAULT, Typeface.BOLD)
                            setTextColor(getColor(R.color.app_foreground))
                        },
                        LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
                    )
                    addView(
                        ImageView(this@MainActivity).apply {
                            setImageResource(R.drawable.ic_chevron_right)
                            setColorFilter(getColor(R.color.app_secondary))
                            contentDescription = null
                        },
                        LinearLayout.LayoutParams(dp(22), dp(22)),
                    )
                }
                row.setOnClickListener {
                    dismissSheet(dialog)
                    entry.third()
                }
                sheet.addView(row, fullWidth())
            }
        }
    }

    private fun deviceRow(device: PairedDeviceRecord): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(UiTokens.gapLg), dp(14), dp(4), dp(14))
            background = roundedRipple(Color.TRANSPARENT, UiTokens.itemRadius)
            isClickable = true
            isFocusable = true
            contentDescription = getString(R.string.open_paired_device, device.displayName)
        }
        val details = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = TextView(this).apply {
            text = device.displayName
            textSize = 15.5f
            setTypeface(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(getColor(R.color.app_foreground))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        val address = TextView(this).apply {
            text = getString(R.string.paired_device_address, device.modeLabel(), device.origin.serialized)
            textSize = UiTokens.captionSmallSp
            setTextColor(getColor(R.color.app_secondary))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MIDDLE
        }
        val status = TextView(this).apply {
            textSize = UiTokens.captionSmallSp
            setTextColor(getColor(R.color.app_secondary))
            deviceStatusViews[device.key] = this
            setDeviceStatusText(this, device)
        }
        details.addView(title)
        details.addView(address, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(3) })
        details.addView(status, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(5) })
        row.addView(details, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        updateDeviceRowAccessibility(row, device, status.text)
        row.addView(toolbarIconButton(R.drawable.ic_more_vertical, R.string.device_actions).apply {
            setOnClickListener { showDeviceActions(device) }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        row.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_chevron_right)
            contentDescription = null
            setColorFilter(getColor(R.color.app_secondary))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(28), dp(48)))
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
        showActionSheet(
            device.displayName,
            actions.map { action ->
                Triple(action.first, action.first == getString(R.string.device_action_delete), action.second)
            },
        )
    }

    private fun repairPairedDevice(device: PairedDeviceRecord) {
        activeDeviceKey = null
        accessMode = device.mode
        if (device.iroh != null) showIrohSetup() else if (device.mode == AccessMode.LAN) showSetup() else showRemoteSetup()
    }

    private fun editDeviceName(device: PairedDeviceRecord) {
        showBottomSheet(getString(R.string.edit_device_name)) { sheet, dialog ->
            val (input, error) = sheetField(
                sheet,
                R.string.device_name_hint,
                R.string.edit_device_name,
                device.displayName,
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
            )
            val save = {
                val name = normalizedDeviceName(input.text.toString())
                if (name == null) {
                    showInlineError(input, error, getString(R.string.invalid_device_name))
                } else {
                    dismissSheet(dialog)
                    if (withCredentialStorage { pairedDeviceStore.update(device.key) { it.copy(displayName = name) } } != null) {
                        showDeviceList()
                    }
                }
            }
            input.setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE) { save(); true } else false
            }
            sheet.addView(
                primaryButton(R.string.save, 52) { save() },
                fullWidth().apply { topMargin = dp(UiTokens.gap) },
            )
        }
    }

    private fun confirmDeleteDevice(device: PairedDeviceRecord) {
        showBottomSheet(getString(R.string.delete_device_title, device.displayName)) { sheet, dialog ->
            sheet.addView(
                TextView(this).apply {
                    setText(R.string.delete_device_message)
                    textSize = UiTokens.bodySmallSp
                    setTextColor(getColor(R.color.app_secondary))
                    setLineSpacing(dp(3).toFloat(), 1f)
                },
                fullWidth().apply { bottomMargin = dp(UiTokens.gapLg) },
            )
            sheet.addView(
                dangerButton(R.string.delete) {
                    dismissSheet(dialog)
                    performDeleteDevice(device)
                },
                fullWidth(),
            )
            sheet.addView(
                sheetRow(getString(R.string.cancel), onClick = { dismissSheet(dialog) }).apply {
                    setTextColor(getColor(R.color.app_secondary))
                },
                fullWidth().apply { topMargin = dp(UiTokens.gapSm) },
            )
        }
    }

    /** Removes one pairing and its stored credentials, then offers an undo strip. */
    private fun performDeleteDevice(device: PairedDeviceRecord) {
        if (!prepareCredentialStorage()) return
        val legacyCredential = credentialStore(device.mode).load()
            ?.takeIf { it.instanceId == device.instanceId }
        val legacyOrigin = preferences.getString(originPreference(device.mode), null)
        if (withCredentialStorage { pairedDeviceStore.remove(device.key) } != true) return
        clearBootAssetStore()
        if (activeDeviceKey == device.key) {
            stopIrohTransport()
            BackgroundNotificationService.disable(this)
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

    private var updateCheckInFlight = false

    /**
     * Ask GitHub for the published App descriptor without involving a paired gateway.
     *
     * The descriptor is the same public file the plugin ships, so the check keeps working
     * when the paired computer is offline; a failed request reports retryable failure and
     * never blocks the device list.
     */
    private fun checkForAppUpdate() {
        if (updateCheckInFlight) return
        updateCheckInFlight = true
        Toast.makeText(this, R.string.checking_updates, Toast.LENGTH_SHORT).show()
        Thread {
            val result = runCatching { AppUpdatePolicy.parseDescriptor(AppUpdatePolicy.fetchDescriptor()) }
            runOnUiThread {
                updateCheckInFlight = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                val published = result.getOrNull()
                when {
                    result.isFailure || published == null -> AlertDialog.Builder(this)
                        .setTitle(R.string.update_check_failed)
                        .setMessage(R.string.update_check_failed_message)
                        .setPositiveButton(R.string.retry) { _, _ -> checkForAppUpdate() }
                        .setNegativeButton(R.string.cancel, null)
                        .show()
                    AppUpdatePolicy.isNewer(published, BuildConfig.VERSION_CODE) -> AlertDialog.Builder(this)
                        .setTitle(R.string.update_available_title)
                        .setMessage(getString(R.string.update_available_message, published.version, BuildConfig.VERSION_NAME))
                        .setPositiveButton(R.string.update_now) { _, _ ->
                            openExternal(Uri.parse(AppUpdatePolicy.releasePageUrl(published.releaseTag)))
                        }
                        .setNegativeButton(R.string.cancel, null)
                        .show()
                    else -> Toast.makeText(this, R.string.update_up_to_date, Toast.LENGTH_SHORT).show()
                }
            }
        }.start()
    }

    private fun showLaunchSettings() {
        val selected = if (launchBehavior() == LaunchBehavior.DEVICE_LIST) 1 else 0
        showChoiceSheet(
            getString(R.string.launch_settings),
            listOf(getString(R.string.launch_direct_dsh), getString(R.string.launch_device_list)),
            selected,
        ) { which ->
            preferences.edit().putString(
                PREFERENCE_LAUNCH_BEHAVIOR,
                if (which == 1) LaunchBehavior.DEVICE_LIST.name else LaunchBehavior.DIRECT_DSH.name,
            ).apply()
            Toast.makeText(this, R.string.launch_setting_saved, Toast.LENGTH_SHORT).show()
        }
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
            Toast.makeText(this, R.string.icon_settings_saved, Toast.LENGTH_SHORT).show()
        } catch (error: Exception) {
            // Package-manager failure is reported without persisting an unconfirmed selection.
            Toast.makeText(this, R.string.icon_settings_failed, Toast.LENGTH_LONG).show()
        }
    }

    /** The one place an icon key becomes a caption; the picker and the summary share it. */
    private fun iconLabelResource(key: String): Int = when (key) {
        "whale_girl" -> R.string.icon_choice_whale_girl
        "mascot_classic" -> R.string.icon_choice_mascot_classic
        "mascot_cheer" -> R.string.icon_choice_mascot_cheer
        "mascot_quiet" -> R.string.icon_choice_mascot_quiet
        "official_whale" -> R.string.icon_choice_official_whale
        "official_whale_dark" -> R.string.icon_choice_official_whale_dark
        "official_whale_teal" -> R.string.icon_choice_official_whale_teal
        "official_whale_mono" -> R.string.icon_choice_official_whale_mono
        "official_whale_black" -> R.string.icon_choice_official_whale_black
        "official_whale_white" -> R.string.icon_choice_official_whale_white
        else -> R.string.icon_choice_whale_girl
    }

    /** A short caption for the settings summary, where the picker's full label does not fit. */
    private fun iconShortLabelResource(key: String): Int = when (key) {
        "whale_girl" -> R.string.icon_short_whale_girl
        "mascot_classic" -> R.string.icon_short_mascot_classic
        "mascot_cheer" -> R.string.icon_short_mascot_cheer
        "mascot_quiet" -> R.string.icon_short_mascot_quiet
        "official_whale" -> R.string.icon_short_official_whale
        "official_whale_dark" -> R.string.icon_short_official_whale_dark
        "official_whale_teal" -> R.string.icon_short_official_whale_teal
        "official_whale_mono" -> R.string.icon_short_official_whale_mono
        "official_whale_black" -> R.string.icon_short_official_whale_black
        "official_whale_white" -> R.string.icon_short_official_whale_white
        else -> R.string.icon_short_whale_girl
    }

    private fun showIconSettings() {
        val keys = LauncherIconPolicy.icons.map { it.key }
        val selected = keys.indexOf(currentAppIcon()).coerceAtLeast(0)
        showChoiceSheet(
            getString(R.string.icon_settings),
            keys.map { getString(iconLabelResource(it)) },
            selected,
            artwork = LauncherIconPolicy.icons.map { it.mipmap },
        ) { which -> applyAppIcon(keys[which]) }
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
        deviceListStatus?.apply {
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

    private fun showSetup() {
        stopIrohTransport()
        cancelRestoreForConfiguration()
        stopDeviceListRefresh()
        invalidatePairingAttempts()
        deviceListVisible = false
        accessMode = AccessMode.LAN
        showingSetup = true
        setupBackAction = ::showDeviceList
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        failureDialog?.dismiss()

        val screen = createSetupScreen(
            R.string.discovery_title,
            R.string.discovery_description,
            back = ::showDeviceList,
            centered = true,
            depth = 1,
        )
        val content = screen.content
        val status = statusLine().apply { setText(R.string.scan_prompt); visibility = View.VISIBLE }
        applyPendingPairingFailure(status)
        val results = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        content.addView(primaryButton(R.string.scan_action, 52) { pairingOrigin = ::showSetup; openScanner() }, fullWidth())
        content.addView(spacer(10))
        content.addView(secondaryButton(R.string.scan_lan, 48) { scanForHarnesses(status, this, results) }, fullWidth())
        content.addView(sectionLabel(R.string.or_paste_link))

        val manualField = field(
            R.string.lan_link_hint,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
            EditorInfo.IME_ACTION_GO,
            56,
            R.string.lan_link_label,
        )
        val manualError = inlineError()
        onFieldEdited(manualField) { clearInlineError(manualField, manualError) }
        val manualAction = { showManualAddress(manualField, manualError, status) }
        manualField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { showManualAddress(manualField, manualError, status); true } else false
        }
        content.addView(manualField, fullWidth())
        content.addView(manualError, fullWidth())
        content.addView(spacer(10))
        content.addView(
            primaryButton(R.string.pair_and_connect, 52) { showManualAddress(manualField, manualError, status) },
            fullWidth(),
        )
        content.addView(spacer(12))
        content.addView(status, fullWidth())
        content.addView(results, fullWidth())
    }

    /**
     * A pasted pairing link carries the one-time token, so it can start pairing
     * directly; a bare address is still accepted and asks for the code next.
     */
    private fun showManualAddress(field: EditText, error: TextView, status: TextView) {
        val raw = field.text.toString().trim()
        if (raw.isEmpty()) {
            showInlineError(field, error, getString(R.string.pairing_link_required))
            return
        }
        val link = GatewayConnection.parse(raw)
        if (link != null && isOriginAllowedForAccessMode(link.origin)
            && GatewayUrlPolicy.pairingKey(raw) != null
        ) {
            clearInlineError(field, error)
            showPairing(
                manualHarness(link.origin),
                prefilledInput = raw,
                autoConnect = true,
                returnTo = ::showSetup,
            )
            return
        }
        val origin = parseManualOrigin(raw)
        if (origin == null) {
            showInlineError(field, error, getString(R.string.invalid_pairing_link))
            showStatus(status, getString(R.string.scan_prompt))
            return
        }
        clearInlineError(field, error)
        connectManual(origin, status)
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
        setupBackAction = ::showDeviceList
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        cancelAutomaticRecovery()
        failureDialog?.dismiss()
        val screen = createSetupScreen(
            R.string.iroh_access_title,
            R.string.iroh_pairing_help,
            back = ::showDeviceList,
            centered = true,
            depth = 1,
        )
        val card = screen.content
        card.addView(
            primaryButton(R.string.scan_action, 52) { pairingOrigin = ::showIrohSetup; openScanner() },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
        )
        card.addView(sectionLabel(R.string.or_paste_code))
        val input = field(R.string.iroh_pairing_hint, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
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
        val inputError = inlineError()
        onFieldEdited(input) { clearInlineError(input, inputError) }
        card.addView(input, fullWidth())
        card.addView(inputError, fullWidth())
        card.addView(spacer(12))
        val status = statusLine().apply {
            setText(R.string.iroh_pairing_private)
            visibility = View.VISIBLE
        }
        applyPendingPairingFailure(status)
        val connect = primaryButton(R.string.pair_and_connect, 52) { }
        fun submit() {
            val descriptor = try { IrohPairingDescriptor.parse(input.text.toString().trim()) } catch (_: Exception) {
                showInlineError(input, inputError, getString(R.string.iroh_pairing_invalid))
                showStatus(status, getString(R.string.iroh_pairing_private))
                return
            }
            if (!prepareCredentialStorage()) return
            clearInlineError(input, inputError)
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
                showInlineError(input, inputError, getString(R.string.iroh_pairing_retry_new))
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
        card.addView(connect, fullWidth())
        card.addView(spacer(12))
        card.addView(status, fullWidth())
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
        setupBackAction = ::showDeviceList
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        failureDialog?.dismiss()

        val screen = createSetupScreen(
            R.string.remote_setup_title,
            R.string.remote_setup_description,
            back = ::showDeviceList,
            centered = true,
            depth = 1,
        )
        val content = screen.content
        val status = statusLine()
        applyPendingPairingFailure(status)
        content.addView(primaryButton(R.string.scan_remote_qr, 52) { pairingOrigin = ::showRemoteSetup; openScanner() }, fullWidth())
        content.addView(sectionLabel(R.string.or_paste_link))
        val linkField = field(
            R.string.remote_link_hint,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
            EditorInfo.IME_ACTION_GO,
            56,
            R.string.remote_link_label,
        )
        val linkError = inlineError()
        onFieldEdited(linkField) { clearInlineError(linkField, linkError) }
        val connectAction = { connectRemoteLink(linkField, linkError, status) }
        linkField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { connectAction(); true } else false
        }
        content.addView(linkField, fullWidth())
        content.addView(linkError, fullWidth())
        content.addView(spacer(10))
        content.addView(primaryButton(R.string.pair_and_connect, 52) { connectAction() }, fullWidth())
        content.addView(spacer(12))
        content.addView(status, fullWidth())
    }

    private fun connectRemoteLink(field: EditText, error: TextView, status: TextView) {
        val raw = field.text.toString()
        if (raw.trim().isEmpty()) {
            showInlineError(field, error, getString(R.string.pairing_link_required))
            return
        }
        val connection = GatewayConnection.parse(raw.trim())
        if (connection == null || !isRemoteTunnelHost(connection.origin.host)
            || GatewayUrlPolicy.pairingKey(raw.trim()) == null) {
            showInlineError(field, error, getString(R.string.invalid_remote_link))
            return
        }
        clearInlineError(field, error)
        showPairing(
            manualHarness(connection.origin),
            prefilledInput = raw.trim(),
            autoConnect = true,
            returnTo = ::showRemoteSetup,
        )
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

    /**
     * One boot-batch cache per WebView. It is null when the patch is switched off, which leaves the
     * WebView as the only owner of every request — exactly the 0.8.1 behaviour.
     */
    private fun createBootAssetCache(
        origin: GatewayOrigin,
        caCertificate: ByteArray?,
        userAgent: String?,
    ): BootAssetCache? {
        if (!BOOT_ASSET_CACHE_ENABLED) return null
        // An iroh page must fetch through its CONNECT proxy, not the platform resolver.
        val transport = runCatching { transportFor(origin) }.getOrDefault(LocalTransport)
        return BootAssetCache(
            origin = origin,
            store = bootAssetStore,
            fetcher = HttpBootAssetFetcher(origin, transport, caCertificate, userAgent),
        ).also { bootAssetCache = it }
    }

    /** Device-benefit measurement: counters only, no cookie, query, origin or session identifier. */
    private fun logBootAssetMetrics(cache: BootAssetCache) {
        runCatching { android.util.Log.i(BOOT_ASSET_LOG_TAG, cache.metrics.snapshot().summary()) }
    }

    /**
     * Clears the stored boot batches off the UI thread: `clear()` deletes files and may wait on the
     * store monitor while a running download holds it across an fsync. Both call sites keep their
     * previous timing (site-data clear and device removal); only the thread changed.
     */
    private fun clearBootAssetStore() {
        if (!BOOT_ASSET_CACHE_ENABLED) return
        val task = Runnable { runCatching { bootAssetStore.clear() } }
        // A shutdown executor (teardown) must not drop the clear, so fall back to running it inline.
        runCatching { ioExecutor.execute(task) }.onFailure { task.run() }
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
        setupBackAction = ::showDeviceList
        destroyWebView()
        val screen = createSetupScreen(R.string.restoring_trust, back = ::showDeviceList, depth = 1)
        screen.content.addView(
            ProgressBar(this).apply { isIndeterminate = true },
            LinearLayout.LayoutParams(dp(44), dp(44)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = dp(48)
            },
        )
    }

    /** Where a pairing form returns when the caller did not name the page it came from. */
    private fun defaultPairingBack(): () -> Unit =
        if (accessMode == AccessMode.LAN) ::showSetup else ::showRemoteSetup

    private fun showPairing(
        harness: DiscoveredHarness,
        prefilledInput: String = "",
        autoConnect: Boolean = false,
        returnTo: (() -> Unit)? = null,
    ) {
        cancelRestoreForConfiguration()
        stopDeviceListRefresh()
        invalidatePairingAttempts()
        deviceListVisible = false
        showingSetup = true
        // The Iroh page also runs in REMOTE mode, so the access mode cannot name the
        // page that a failed key or the Back action should return to.
        val backTo = returnTo ?: pairingOrigin ?: defaultPairingBack()
        pairingOrigin = null
        setupBackAction = backTo
        val screen = createSetupScreen(
            R.string.pairing_title,
            R.string.pairing_description,
            back = backTo,
            depth = 2,
        )
        val card = screen.content
        card.addView(textView(R.string.selected_harness, 14f, Typeface.BOLD))
        card.addView(spacer(6))
        card.addView(TextView(this).apply {
            text = "${harness.deviceName}\n${harness.origin.serialized}"
            textSize = UiTokens.bodySp
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
        val status = statusLine().apply {
            visibility = View.GONE
        }
        val leaveForm: () -> Unit = { backTo() }
        // A key that arrived by scan or paste is one-time: once it fails this form
        // cannot retry it, so the failure returns to where the key came from.
        val ephemeralFailure: ((Int) -> Unit)? = if (autoConnect) {
            { messageResource ->
                pendingPairingFailure = messageResource
                leaveForm()
            }
        } else {
            null
        }
        val connect = primaryButton(R.string.pair_and_connect, 52) {
            connect(harness, pairing, status, this, ephemeralFailure)
        }
        pairing.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                connect(harness, pairing, status, connect, ephemeralFailure)
                true
            } else {
                false
            }
        }
        card.addView(connect, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(spacer(10))
        card.addView(status)
        card.addView(spacer(12))
        card.addView(secondaryButton(R.string.back_to_scan, 48) { leaveForm() },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        if (autoConnect && prefilledInput.isNotEmpty()) connect(harness, pairing, status, connect, ephemeralFailure)
    }

    /** Type scale and geometry shared by the native screens. */
    private object UiTokens {
        const val screenPadding = 20
        const val cardRadius = 20
        const val itemRadius = 16
        const val controlRadius = 14
        const val iconRadius = 12
        const val gapSm = 8
        const val gap = 12
        const val gapLg = 16
        const val titleSp = 27f
        const val displaySp = 20f
        const val headerSp = 17f
        const val itemTitleSp = 15.5f
        const val bodySp = 15f
        const val bodySmallSp = 14f
        const val captionSp = 12.5f
        const val captionSmallSp = 11.5f
        const val buttonSp = 15f
    }

    /** The shell parts a screen can extend after creation. */
    private data class SetupScreen(
        val root: FrameLayout,
        val header: LinearLayout,
        val content: LinearLayout,
        val subtitle: TextView? = null,
    )

    /**
     * Opaque base plus a bottom falloff. The moving colour lives in addMistBackdrop.
     */
    private fun screenBackground(): Drawable {
        // Opaque base plus a bottom falloff: the moving colour lives in addMistBackdrop.
        val base = GradientDrawable().apply { setColor(getColor(R.color.app_background)) }
        val falloff = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, getColor(R.color.app_background)),
        )
        return android.graphics.drawable.LayerDrawable(arrayOf(base, falloff))
    }

    /**
     * The drifting mist: the wash is painted once on an oversized view and only its
     * translation and scale animate, so the colour field moves without a repaint.
     */
    private fun addMistBackdrop(root: FrameLayout) {
        val metrics = resources.displayMetrics
        val width = metrics.widthPixels * 2
        val height = metrics.heightPixels * 2
        val mist = View(this).apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(
                    getColor(R.color.app_aurora_one),
                    getColor(R.color.app_background),
                    getColor(R.color.app_aurora_two),
                    getColor(R.color.app_background),
                    getColor(R.color.app_aurora_three),
                    getColor(R.color.app_background),
                ),
            )
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        root.addView(
            mist,
            FrameLayout.LayoutParams(width, height).apply {
                leftMargin = -(width - metrics.widthPixels) / 2
                topMargin = -(height - metrics.heightPixels) / 2
            },
        )
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val mistAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 26_000
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = android.view.animation.AccelerateDecelerateInterpolator()
            addUpdateListener { animation ->
                val progress = animation.animatedValue as Float
                val drift = dp(44).toFloat()
                mist.translationX = -drift * progress
                mist.translationY = drift * 0.6f * progress
                mist.scaleX = 1f + 0.05f * progress
                mist.scaleY = 1f + 0.05f * progress
            }
        }
        trackBackdrop(mistAnimator, mist)
    }

    /**
     * A barely-there grid over the wash, drifting one cell at a time. The pattern is
     * a repeating shader on a view slightly larger than the screen, and only its
     * translation animates, so the frame never repaints the grid itself.
     */
    private fun addGridBackdrop(root: FrameLayout) {
        val cell = dp(28).coerceAtLeast(8)
        val tile = Bitmap.createBitmap(cell, cell, Bitmap.Config.ARGB_8888)
        val tileCanvas = Canvas(tile)
        val line = Paint().apply {
            color = getColor(R.color.app_grid_line)
            strokeWidth = 1f
        }
        tileCanvas.drawLine(cell - 1f, 0f, cell - 1f, cell.toFloat(), line)
        tileCanvas.drawLine(0f, cell - 1f, cell.toFloat(), cell - 1f, line)
        val grid = object : View(this) {
            override fun onDraw(canvas: Canvas) {
                canvas.drawPaint(
                    Paint().apply {
                        shader = BitmapShader(tile, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
                    },
                )
            }
        }
        grid.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        root.addView(
            grid,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ).apply {
                // the backdrop drifts, so it overhangs by one cell on every side
                width = resources.displayMetrics.widthPixels + cell * 2
                height = resources.displayMetrics.heightPixels + cell * 2
                leftMargin = -cell
                topMargin = -cell
            },
        )
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val gridAnimator = ValueAnimator.ofFloat(0f, -cell.toFloat()).apply {
            duration = 30_000
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener { animation ->
                val offset = animation.animatedValue as Float
                grid.translationX = offset
                grid.translationY = offset
            }
        }
        trackBackdrop(gridAnimator, grid)
    }

    /**
     * Shared frame for every native screen: gradient background, one header row
     * (secondary screens show a back affordance) and a centred content column.
     * Artwork no longer sits behind the text, so long addresses keep contrast and
     * the tablet column stays the width of the phone one.
     */
    private fun createSetupScreen(
        titleResource: Int,
        subtitleResource: Int? = null,
        back: (() -> Unit)? = null,
        centered: Boolean = false,
        depth: Int = 1,
        animate: Boolean = true,
    ): SetupScreen {
        applyStatusBarIconContrast(window, getColor(R.color.app_background))
        val root = FrameLayout(this).apply { background = screenBackground() }
        addMistBackdrop(root)
        addGridBackdrop(root)
        val frame = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(
            frame,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
        )
        val available = (resources.displayMetrics.widthPixels - dp(UiTokens.screenPadding * 2)).coerceAtLeast(dp(280))
        val columnWidth = min(available, dp(560))
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(UiTokens.screenPadding), dp(16), dp(UiTokens.screenPadding), dp(6))
        }
        if (back != null) {
            header.addView(
                backButton(back),
                LinearLayout.LayoutParams(dp(48), dp(48)).apply { rightMargin = dp(10) },
            )
        }
        header.addView(
            TextView(this).apply {
                setText(titleResource)
                textSize = if (back == null) UiTokens.titleSp else UiTokens.headerSp
                setTypeface(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(getColor(R.color.app_foreground))
            },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        frame.addView(
            header,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
        }
        frame.addView(
            scroll,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f),
        )
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            if (centered) gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(UiTokens.screenPadding), dp(8), dp(UiTokens.screenPadding), dp(96))
        }
        scroll.addView(
            column,
            FrameLayout.LayoutParams(
                columnWidth,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL,
            ),
        )
        val subtitleView = subtitleResource?.let { resource ->
            TextView(this).apply {
                setText(resource)
                textSize = UiTokens.captionSp
                setTextColor(getColor(R.color.app_secondary))
            }.also { view ->
                column.addView(
                    view,
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(6) },
                )
            }
        }
        column.addView(spacer(if (centered) 6 else 18))
        setPageContent(root, depth, animate)
        applySafeAreaInsets(root)
        return SetupScreen(root, header, column, subtitleView)
    }

    /**
     * Raised fill for the primary action: a three-stop vertical gradient with its own
     * pressed state, so the control reads as a surface instead of a coloured rectangle.
     */
    private fun reliefBackground(
        radiusDp: Int,
        top: Int, mid: Int, bottom: Int,
        topPressed: Int, midPressed: Int, bottomPressed: Int,
    ): Drawable {
        fun fill(topColor: Int, midColor: Int, bottomColor: Int) =
            GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(topColor, midColor, bottomColor),
            ).apply {
                cornerRadius = dp(radiusDp).toFloat()
            }
        val states = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed),
                fill(getColor(topPressed), getColor(midPressed), getColor(bottomPressed)))
            addState(intArrayOf(), fill(getColor(top), getColor(mid), getColor(bottom)))
        }
        return RippleDrawable(
            ColorStateList.valueOf(getColor(R.color.app_button_edge)),
            states,
            null,
        )
    }

    /** Quiet glass fill: two soft white stops, no stroke and no shadow. */
    private fun glassBackground(radiusDp: Int): Drawable {
        fun fill(pressed: Boolean) = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(
                getColor(if (pressed) R.color.app_surface_tinted else R.color.app_glass_top),
                getColor(R.color.app_glass_bottom),
            ),
        ).apply {
            cornerRadius = dp(radiusDp).toFloat()
        }
        val states = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), fill(true))
            addState(intArrayOf(), fill(false))
        }
        return RippleDrawable(ColorStateList.valueOf(Color.TRANSPARENT), states, null)
    }

    /** Gradient hairline used between grouped rows; both ends fade out. */
    private fun fadingDivider(): View = View(this).apply {
        background = GradientDrawable(
            GradientDrawable.Orientation.LEFT_RIGHT,
            intArrayOf(Color.TRANSPARENT, getColor(R.color.app_divider), Color.TRANSPARENT),
        )
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /** Glass surface shared by cards and rows: translucent fill plus a hairline. */
    private fun glassSurface(
        colorResource: Int = R.color.app_card_fill,
        radiusDp: Int = UiTokens.itemRadius,
    ): Drawable {
        val edge = GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(getColor(R.color.app_card_edge_top), getColor(R.color.app_card_edge_bottom)),
        ).apply { cornerRadius = dp(radiusDp).toFloat() }
        val fill = roundedSurface(getColor(colorResource), radiusDp)
        return android.graphics.drawable.LayerDrawable(
            arrayOf(edge, android.graphics.drawable.InsetDrawable(fill, dp(1))),
        )
    }

    private fun backButton(back: () -> Unit): ImageButton = ImageButton(this).apply {
        setImageResource(R.drawable.ic_arrow_back)
        contentDescription = getString(R.string.back)
        setColorFilter(getColor(R.color.app_foreground))
        scaleType = ImageView.ScaleType.CENTER
        setPadding(dp(9), dp(9), dp(9), dp(9))
        background = roundedRipple(getColor(R.color.app_surface), 12)
        setOnClickListener { back() }
    }

    /** Bottom action with the brand gradient; screens place it over their scroll view. */
    private fun screenAction(labelResource: Int, onClick: () -> Unit): TextView = TextView(this).apply {
        setText(labelResource)
        textSize = UiTokens.buttonSp
        setTypeface(Typeface.DEFAULT, Typeface.BOLD)
        setTextColor(getColor(R.color.app_button_text))
        gravity = Gravity.CENTER
        minHeight = dp(54)
        letterSpacing = 0.02f
        elevation = dp(10).toFloat()
        background = reliefBackground(
            UiTokens.controlRadius,
            R.color.app_button_top, R.color.app_button_mid, R.color.app_button_bottom,
            R.color.app_button_top_pressed, R.color.app_button_mid_pressed, R.color.app_button_bottom_pressed,
        )
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    private fun connectManual(origin: GatewayOrigin, status: TextView) {
        val credential = legacyCredentialForRestore()
        if (credential != null) {
            showRestoringTrust()
            restoreTrustedDevice(origin, credential) {
                showPairing(manualHarness(origin), returnTo = ::showDeviceList)
            }
        } else {
            showPairing(manualHarness(origin), returnTo = ::showDeviceList)
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

    /**
     * @param onEphemeralFailure when set, a failure is handed to the caller instead
     * of being painted here: a scanned or pasted one-time key cannot be retried on
     * this form, so the caller returns to where the key came from.
     */
    private fun connect(
        harness: DiscoveredHarness,
        pairing: EditText,
        status: TextView,
        button: Button,
        onEphemeralFailure: ((Int) -> Unit)? = null,
    ) {
        if (pairingAttemptGate.busy) return
        if (!prepareCredentialStorage()) {
            status.setText(R.string.device_storage_unavailable)
            status.visibility = View.VISIBLE
            return
        }
        // One exit for "the computer rejected or could not be reached": a key that
        // arrived by scan or paste is spent, so the caller takes the failure back.
        fun reportPairingFailure(messageResource: Int) {
            if (onEphemeralFailure != null) onEphemeralFailure(messageResource)
            else showStatus(status, messageResource, error = true)
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
                    reportPairingFailure(pairingFailureMessage(trustFailure, origin))
                    completePairingAttempt(generation)
                    button.isEnabled = true
                }
                return@execute
            }
            val trust = trustAttempt.getOrNull()
            if (trust == null) {
                runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    reportPairingFailure(R.string.pairing_tls_failed)
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
                            reportPairingFailure(R.string.pairing_failed)
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
                        reportPairingFailure(pairingFailureMessage(renewalFailure, origin))
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
                        reportPairingFailure(R.string.device_storage_unavailable)
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
                        reportPairingFailure(R.string.pairing_failed)
                        completePairingAttempt(generation)
                        button.isEnabled = true
                    } else if (!runCatching {
                            pairedDeviceStore.requireReadable()
                            if (!pairedDeviceStore.isMigrationComplete()) {
                                store.save(DeviceCredential(session.instanceId, deviceToken, expiresAt, certificate))
                            }
                        }.isSuccess) {
                        reportPairingFailure(R.string.device_storage_unavailable)
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
                    reportPairingFailure(pairingFailureMessage(error, origin))
                    completePairingAttempt(generation)
                    button.isEnabled = true
                } }
        }
    }

    private fun showCompatibilityIssue(issue: CompatibilityIssue, status: TextView, button: Button) {
        button.isEnabled = true
        val required = issue.requiredVersion.orEmpty()
        val (title, message) = when (issue.kind) {
            CompatibilityIssueKind.APP_TOO_OLD -> R.string.app_update_required_title to getString(R.string.app_update_required_message, required)
            CompatibilityIssueKind.PLUGIN_TOO_OLD -> R.string.plugin_update_required_title to getString(R.string.plugin_update_required_message, required)
            CompatibilityIssueKind.PROTOCOL_UNSUPPORTED -> R.string.connection_version_mismatch_title to getString(R.string.connection_version_mismatch_message)
        }
        showStatus(status, message, error = true)
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
        NativeAuthFailureKind.SOURCE_NETWORK_UNTRUSTED -> R.string.pairing_source_untrusted
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
                    showStatus(status, R.string.no_harness_found, error = true)
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
                                    restoreTrustedDevice(harness.origin, trustedCredential) {
                                        showPairing(harness, returnTo = ::showDeviceList)
                                    }
                                } else {
                                    showPairing(harness, returnTo = ::showDeviceList)
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
            pairingOrigin = null
            showIrohSetup(text, autoConnect = true)
            return
        }
        val target = PairingScanPolicy.parse(text, accessMode)
        if (target != null) {
            accessMode = target.mode
            showPairing(
                manualHarness(target.connection.origin),
                prefilledInput = text,
                autoConnect = true,
                returnTo = pairingOrigin ?: ::showRemoteSetup,
            )
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
        runCatching { BackgroundNotificationService.resumeIfEnabled(this, record.key) }
    }

    private fun showPairedDeviceNamePrompt(record: PairedDeviceRecord, complete: () -> Unit) {
        var settled = false
        fun finish() {
            if (settled) return
            settled = true
            complete()
        }
        val dialog = showBottomSheet(getString(R.string.name_new_device), dismissOnPause = false) { sheet, sheetDialog ->
            sheet.addView(
                TextView(this).apply {
                    setText(R.string.name_new_device_message)
                    textSize = UiTokens.bodySmallSp
                    setTextColor(getColor(R.color.app_secondary))
                    setLineSpacing(dp(3).toFloat(), 1f)
                },
                fullWidth().apply { bottomMargin = dp(UiTokens.gap) },
            )
            val (input, error) = sheetField(
                sheet,
                R.string.device_name_hint,
                R.string.name_new_device,
                record.displayName,
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
            )
            val saveAndConnect = {
                    val name = normalizedDeviceName(input.text.toString())
                    if (name == null) {
                        showInlineError(input, error, getString(R.string.invalid_device_name))
                    } else {
                        // Close only after a confirmed write: a failed save must leave
                        // Skip reachable, or the pairing flow can never complete.
                        val saved = withCredentialStorage {
                            pairedDeviceStore.update(record.key) { it.copy(displayName = name) }
                        } != null
                        dismissSheet(sheetDialog)
                        if (saved) finish() else toastError(R.string.session_storage_failed).also { finish() }
                    }
            }
            input.setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE) { saveAndConnect(); true } else false
            }
            sheet.addView(
                primaryButton(R.string.save_and_connect, 52) { saveAndConnect() },
                fullWidth().apply { topMargin = dp(UiTokens.gap) },
            )
            sheet.addView(
                sheetRow(getString(R.string.skip)) {
                    dismissSheet(sheetDialog)
                    finish()
                },
                fullWidth(),
            )
        }
        dialog.setOnCancelListener { finish() }
    }

    private fun handleDeviceRevoked() {
        val key = activeDeviceKey ?: return
        withCredentialStorage { pairedDeviceStore.update(key) { it.copy(status = PairedDeviceStatus.REVOKED) } }
        runOnUiThread {
            if (activeDeviceKey != key || isFinishing || isDestroyed) return@runOnUiThread
            BackgroundNotificationService.disable(this)
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
    private var sameHostConfirmation: Dialog? = null
    private var sameHostRestoreAttempt: ConnectionAttemptController.Attempt? = null
    private var sameHostProbeCancellation: NativeConnectionCancellation? = null
    private var sameHostObservedWifi: Boolean? = null
    private fun sameHostMode() = SameHostSwitchMode.resolve(preferences.getString("same_host_mode", null),
        preferences.getBoolean("automatic_same_host", false))
    private fun automaticSameHost() = sameHostMode() != SameHostSwitchMode.MANUAL

    private fun showSameHostSettings() {
        showChoiceSheet(
            getString(R.string.same_host_title),
            listOf(
                getString(R.string.same_host_manual),
                getString(R.string.same_host_detect),
                getString(R.string.same_host_enable),
            ),
            sameHostMode().ordinal,
        ) { which ->
            if (which == SameHostSwitchMode.AUTOMATIC.ordinal) {
                confirmSameHostSwitch(which)
            } else {
                saveSameHostMode(which)
            }
        }
    }

    /** Enabling the automatic switch changes how reconnects behave, so it asks first. */
    private fun confirmSameHostSwitch(mode: Int) {
        val dialog = showBottomSheet(
            getString(R.string.same_host_enable),
            onDismiss = { sameHostConfirmation = null },
        ) { sheet, sheetDialog ->
            sheet.addView(
                TextView(this).apply {
                    setText(R.string.same_host_limits)
                    textSize = UiTokens.bodySmallSp
                    setTextColor(getColor(R.color.app_secondary))
                    setLineSpacing(dp(3).toFloat(), 1f)
                },
                fullWidth().apply { bottomMargin = dp(UiTokens.gapLg) },
            )
            sheet.addView(
                primaryButton(R.string.same_host_enable, 52) {
                    dismissSheet(sheetDialog)
                    saveSameHostMode(mode)
                },
                fullWidth(),
            )
            sheet.addView(
                sheetRow(getString(R.string.cancel), onClick = { dismissSheet(sheetDialog) }).apply {
                    setTextColor(getColor(R.color.app_secondary))
                },
                fullWidth().apply { topMargin = dp(UiTokens.gapSm) },
            )
        }
        // A sheet that never reached the screen must not block the automatic switch.
        if (dialog.isShowing) sameHostConfirmation = dialog
    }

    private fun saveSameHostMode(mode: Int) {
        preferences.edit().putString("same_host_mode", SameHostSwitchMode.entries[mode].name).apply()
        sameHostGate.invalidate()
        sameHostProbeCancellation?.cancel()
        sameHostProbeCancellation = null
        // dismiss() delivers its listener asynchronously; clear first so the guard
        // in checkSameHostConnection does not skip the immediate recheck.
        sameHostConfirmation = null
        checkSameHostConnection()
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
            deviceListStatus?.let { showStatus(it, R.string.webview_renderer_failed, error = true) }
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
        // Held so the picture-in-picture callback can shrink the page instead of refitting it.
        this.displayScale = displayScale
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
            bootAssets = BootAssetResponder(createBootAssetCache(origin, caCertificate, browser.settings.userAgentString)),
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
                    bootAssetCache?.let(::logBootAssetMetrics)
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
            bridge.onGetBackgroundNotifications = {
                BackgroundNotificationService.isEnabled(this) && activeDeviceKey != null
            }
            bridge.onGetBackgroundNotificationStatus = {
                BackgroundNotificationService.status(this)
            }
            bridge.onSetBackgroundNotifications = ::setBackgroundNotifications
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
        val baseUrl = requestedInitialUrl.takeIf { GatewayUrlPolicy.isSameOrigin(origin, it) }
            ?: origin.serialized
        val initialUrl = pendingNotificationNavigate?.let { nav ->
            val full = origin.serialized.trimEnd('/') + nav
            if (GatewayUrlPolicy.isSameOrigin(origin, full)) full else baseUrl
        } ?: baseUrl
        pendingNotificationNavigate = null
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

    /**
     * Opt-in persistent delivery is owned by the active paired computer. An iroh
     * device stays on the in-page path until the native transport can expose the
     * same exact public-key/TLS identity to a foreground service.
     */
    private fun setBackgroundNotifications(enabled: Boolean): Boolean {
        if (!enabled) {
            runCatching { BackgroundNotificationService.disable(this) }
            return true
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            openTaskNotificationSettings()
            return false
        }
        val key = activeDeviceKey ?: return false
        if (gatewayOrigin == null) return false
        val device = pairedDeviceStore.load().firstOrNull { it.key == key } ?: return false
        if (device.iroh != null) return false
        return runCatching { BackgroundNotificationService.enable(this, key) }.getOrDefault(false)
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
        displayScale = null
        stopIrohStatusMonitor()
        cancelPageSessionRenewal()
        invalidateWebFileChooser()
        cancelPendingWebBack()
        secureWebViewClient?.dispose()
        secureWebViewClient = null
        bootAssetCache?.let { cache ->
            logBootAssetMetrics(cache)
            // Cancels in-flight downloads and stops the worker threads this WebView owned.
            cache.close()
        }
        bootAssetCache = null
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
        textSize = UiTokens.buttonSp
        setTypeface(Typeface.DEFAULT, Typeface.BOLD)
        minHeight = dp(maxOf(minHeightDp, 54))
        backgroundTintList = null
        letterSpacing = 0.02f
        background = reliefBackground(
            UiTokens.itemRadius,
            R.color.app_button_top, R.color.app_button_mid, R.color.app_button_bottom,
            R.color.app_button_top_pressed, R.color.app_button_mid_pressed, R.color.app_button_bottom_pressed,
        )
        val lift = this
        // Pressing sinks the button into the surface: it drops its lift and shrinks
        // a hair, which reads as depth instead of a colour swap.
        val press = android.animation.AnimatorSet().apply {
            playTogether(
                android.animation.ObjectAnimator.ofFloat(lift, "translationZ", dp(0).toFloat()),
                android.animation.ObjectAnimator.ofFloat(lift, "scaleX", 0.975f),
                android.animation.ObjectAnimator.ofFloat(lift, "scaleY", 0.975f),
            )
        }
        val rest = android.animation.AnimatorSet().apply {
            playTogether(
                android.animation.ObjectAnimator.ofFloat(lift, "translationZ", dp(4).toFloat()),
                android.animation.ObjectAnimator.ofFloat(lift, "scaleX", 1f),
                android.animation.ObjectAnimator.ofFloat(lift, "scaleY", 1f),
            )
        }
        stateListAnimator = android.animation.StateListAnimator().apply {
            addState(intArrayOf(android.R.attr.state_pressed), press)
            addState(intArrayOf(), rest)
        }
        setTextColor(getColor(R.color.app_button_text))
        setOnClickListener { onClick() }
    }

    /** Secondary action button: glass fill, quieter than the primary one. */
    private fun secondaryButton(textResource: Int, minHeightDp: Int, onClick: Button.() -> Unit): Button = Button(this).apply {
        setText(textResource)
        isAllCaps = false
        textSize = 14f
        letterSpacing = 0.015f
        minHeight = dp(maxOf(minHeightDp, 52))
        setTextColor(getColor(R.color.app_on_accent_container))
        backgroundTintList = null
        background = glassBackground(UiTokens.itemRadius)
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
        textSize = 15f
        setTextColor(getColor(R.color.app_foreground))
        setHintTextColor(getColor(R.color.app_secondary))
        setPadding(dp(16), dp(14), dp(16), dp(14))
        background = fieldSurface(false)
        this.contentDescription = getString(contentDescriptionResource)
        setOnFocusChangeListener { view, _ -> view.background = fieldSurface(view.hasFocus()) }
    }

    /**
     * Focused fields swap the hairline for the accent stroke and an invalid field
     * takes the error stroke, so focus and failure never look the same.
     */
    private fun fieldSurface(focused: Boolean, invalid: Boolean = false): Drawable =
        GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            intArrayOf(
                getColor(R.color.app_field_inset_top),
                getColor(R.color.app_field_inset_bottom),
            ),
        ).apply {
            cornerRadius = dp(14).toFloat()
            setStroke(
                dp(if (focused && !invalid) 2 else 1),
                getColor(
                    when {
                        invalid -> R.color.app_error
                        focused -> R.color.app_accent
                        else -> R.color.app_border
                    },
                ),
            )
        }

    /** One column width for every control in the pairing screens. */
    private fun fullWidth(): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

    /** Validation label that sits directly under the field it belongs to. */
    private fun inlineError(): TextView = TextView(this).apply {
        textSize = 12.5f
        maxLines = 2
        ellipsize = TextUtils.TruncateAt.END
        setTextColor(getColor(R.color.app_error))
        visibility = View.GONE
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        setPadding(dp(4), dp(8), dp(4), 0)
    }

    /** Mark a field invalid and explain why under it; the reason never floats elsewhere. */
    private fun showInlineError(field: EditText, label: TextView, message: CharSequence) {
        label.text = message
        label.visibility = View.VISIBLE
        field.background = fieldSurface(field.hasFocus(), invalid = true)
        if (!field.hasFocus()) field.requestFocus()
    }

    private fun clearInlineError(field: EditText, label: TextView) {
        label.visibility = View.GONE
        field.background = fieldSurface(field.hasFocus())
    }

    /** Editing a field drops its own validation message instead of leaving it stale. */
    private fun onFieldEdited(field: EditText, action: () -> Unit) {
        field.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = action()
            override fun afterTextChanged(text: android.text.Editable?) = Unit
        })
    }

    /**
     * Status line for an operation: neutral while working and a tinted error strip
     * when it fails, so a failure never reads like plain helper text.
     */
    private fun statusLine(): TextView = TextView(this).apply {
        textSize = 13f
        setTextColor(getColor(R.color.app_secondary))
        visibility = View.GONE
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        setPadding(dp(14), dp(12), dp(14), dp(12))
    }

    /**
     * A failure that sent a one-time key back to the page it came from stays there:
     * the guidance for an expired or unreachable key does not survive a short toast.
     */
    private fun applyPendingPairingFailure(status: TextView) {
        val failure = pendingPairingFailure ?: return
        pendingPairingFailure = null
        showStatus(status, failure, error = true)
    }

    private fun showStatus(view: TextView, message: CharSequence, error: Boolean = false) {
        view.text = message
        view.visibility = View.VISIBLE
        if (error) {
            view.setTextColor(getColor(R.color.app_error))
            view.background = roundedSurface(getColor(R.color.app_error_container), 12).apply {
                setStroke(dp(1), getColor(R.color.app_error))
            }
        } else {
            view.setTextColor(getColor(R.color.app_secondary))
            view.background = null
        }
    }

    private fun showStatus(view: TextView, messageResource: Int, error: Boolean = false) =
        showStatus(view, getString(messageResource), error)

    /** Divider that marks where the primary entry method ends and the manual one starts. */
    private fun sectionLabel(textResource: Int): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, dp(UiTokens.gapLg), 0, dp(UiTokens.gap))
        addView(
            View(this@MainActivity).apply { setBackgroundColor(getColor(R.color.app_border)) },
            LinearLayout.LayoutParams(0, dp(1), 1f),
        )
        addView(
            TextView(this@MainActivity).apply {
                setText(textResource)
                textSize = 12f
                setTextColor(getColor(R.color.app_secondary))
            },
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { leftMargin = dp(12); rightMargin = dp(12) },
        )
        addView(
            View(this@MainActivity).apply { setBackgroundColor(getColor(R.color.app_border)) },
            LinearLayout.LayoutParams(0, dp(1), 1f),
        )
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
        const val EXTRA_REOPEN_SETTINGS = "reopen_settings"
        const val PREFERENCE_PICTURE_IN_PICTURE = "picture_in_picture"
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
        const val BOOT_ASSET_LOG_TAG = "DSHMobile"
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
