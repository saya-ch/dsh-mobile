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
import android.provider.Settings
import android.text.TextUtils
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
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

    private val preferences by lazy { getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE) }
    private val lanCredentialStore by lazy { DeviceCredentialStore(this, "lan") }
    private val remoteCredentialStore by lazy { DeviceCredentialStore(this, "remote") }
    private val pairedDeviceStore by lazy { PairedDeviceStore(this) }
    private var legacyStorageUnavailable = false
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val restoreExecutor = Executors.newFixedThreadPool(3)
    private val recoveryHandler = Handler(Looper.getMainLooper())
    private val restoreUiHandler = Handler(Looper.getMainLooper())
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
    private var gatewayOrigin: GatewayOrigin? = null
    private var accessMode = AccessMode.LAN
    private var setupBackAction: (() -> Unit)? = null
    private var uploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingDownload: PendingDownload? = null
    private var failureDialog: AlertDialog? = null
    private var retryUrl: String? = null
    private var pendingScan: (() -> Unit)? = null
    private var nearbyPermissionLimited = false
    private var showingSetup = false
    @Volatile
    private var restoreGeneration = 0
    @Volatile
    private var pairingGeneration = 0
    private var connectionCenterStatus: TextView? = null
    private var recoveryAttempt = 0
    private var recoveryScheduled = false
    private var restoreEscapeRunnable: Runnable? = null
    private val warnedTailscaleOrigins = mutableSetOf<String>()
    private var deviceListGeneration = 0
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
        when (requestCode) {
            FILE_CHOOSER_REQUEST -> finishFileSelection(resultCode, data)
            DOWNLOAD_DESTINATION_REQUEST -> finishDownloadSelection(resultCode, data)
            SCAN_QR_REQUEST -> finishScanResult(resultCode, data)
        }
    }

    override fun onResume() {
        super.onResume()
        nativeBridge?.onHostResumed()
        webView?.onResume()
        window.decorView.requestApplyInsets()
        if (deviceListVisible && showingSetup) refreshDeviceStatuses(pairedDeviceStore.load())
    }

    override fun onPause() {
        pauseDeviceListRefresh()
        cancelPendingWebBack()
        nativeBridge?.updateKeyboardState(NativeKeyboardState(false, false))
        webView?.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        dismissDeviceUndo()
        stopDeviceListRefresh()
        cancelAutomaticRecovery()
        cancelRestoreEscape()
        invalidateRestoreAttempts()
        invalidatePairingAttempts()
        failureDialog?.dismiss()
        uploadCallback?.onReceiveValue(null)
        uploadCallback = null
        retryUrl = null
        destroyWebView(isChangingConfigurations)
        if (!isChangingConfigurations) {
            restoredNativeBridgeState?.let { NativeBridge.disposeSavedState(this, it) }
            restoredNativeBridgeState = null
        }
        ioExecutor.shutdownNow()
        restoreExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun handleBack() {
        if (isFinishing || isDestroyed) return
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
        activeDeviceKey = preferred.key
        restoreStartupDevice(preferred)
    }

    private fun restoreStartupDevice(device: PairedDeviceRecord) {
        // Direct startup should not flash the device list. Keep a small native
        // loading surface while the most recently used device is renewed.
        showRestoringTrust(device.key)
        activeDeviceKey = device.key
        restoreTrustedDevice(
            preferredOrigin = device.origin,
            credential = device.credential(),
            mode = device.mode,
            generation = beginRestoreAttempt(),
            deviceKey = device.key,
        ) { disposition ->
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
        cancelRestoreEscape()
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

    private fun PairedDeviceRecord.modeLabel(): String = when (mode) {
        AccessMode.LAN -> getString(R.string.connection_mode_lan)
        AccessMode.REMOTE -> getString(R.string.connection_mode_remote)
    }

    private fun setDeviceStatusText(view: TextView, device: PairedDeviceRecord) {
        val current = device.key == activeDeviceKey && webView != null
        val statusResource = when {
            current -> R.string.device_status_current
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
        val color = getColor(if (device.status == PairedDeviceStatus.REACHABLE || current) R.color.app_success else R.color.app_secondary)
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
        val generation = ++deviceListGeneration
        devices.forEach { device ->
            if (device.status == PairedDeviceStatus.REVOKED) return@forEach
            restoreExecutor.execute {
                val result = runCatching {
                    NativeAuthClient.probe(device.origin, device.deviceToken, device.caCertificate, device.instanceId)
                }.recoverCatching { failure ->
                    // Older plugins do not expose the session-free probe yet.
                    // Keep their trusted renewal path as a compatibility fallback.
                    if ((failure as? NativeAuthFailure)?.kind != NativeAuthFailureKind.INVALID_RESPONSE) throw failure
                    val session = NativeAuthClient.renew(device.origin, device.deviceToken, device.caCertificate, device.instanceId)
                    NativeProbe(device.origin, device.instanceId, session.deviceId, device.expiresAt)
                }
                val probe = result.getOrNull()
                runOnUiThread {
                    if (generation != deviceListGeneration || isFinishing || isDestroyed) return@runOnUiThread
                    val updated = withCredentialStorage { pairedDeviceStore.update(device.key) { current ->
                        PairedDeviceStatusPolicy.applyProbe(
                            current,
                            device,
                            probe,
                            (result.exceptionOrNull() as? NativeAuthFailure)?.kind,
                            System.currentTimeMillis(),
                        )
                    } }
                    updated?.let { setDeviceStatusText(deviceStatusViews[device.key] ?: return@let, it) }
                }
            }
        }
        deviceListRefreshRunnable = Runnable {
            if (!isFinishing && !isDestroyed && deviceListVisible && showingSetup && pairedDeviceStore.load().isNotEmpty()) refreshDeviceStatuses(pairedDeviceStore.load())
        }.also { deviceStatusHandler.postDelayed(it, DEVICE_STATUS_REFRESH_MS) }
    }

    private fun stopDeviceListRefresh() {
        deviceListGeneration += 1
        deviceListRefreshRunnable?.let(deviceStatusHandler::removeCallbacks)
        deviceListRefreshRunnable = null
        deviceStatusViews.clear()
    }

    private fun pauseDeviceListRefresh() {
        deviceListGeneration += 1
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
        actions.add(getString(R.string.device_action_check) to check@ {
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
        if (device.mode == AccessMode.LAN) showSetup() else showRemoteSetup()
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
            .setItems(arrayOf(getString(R.string.launch_settings), getString(R.string.icon_settings))) { _, which ->
                if (which == 0) showLaunchSettings() else showIconSettings()
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
        if (device.status == PairedDeviceStatus.REVOKED
            || device.status == PairedDeviceStatus.EXPIRED
            || device.status == PairedDeviceStatus.ADDRESS_CHANGED
        ) {
            showDeviceActions(device)
            return
        }
        activeDeviceKey = device.key
        accessMode = device.mode
        (deviceListStatus ?: connectionCenterStatus)?.apply {
            text = getString(R.string.connecting_to_device, device.displayName)
            visibility = View.VISIBLE
        }
        restoreTrustedDevice(device.origin, device.credential(), device.mode, beginRestoreAttempt(), deviceKey = device.key) { disposition ->
            if (disposition != RestoreFailureDisposition.RETRY_TRANSIENT) {
                withCredentialStorage { pairedDeviceStore.update(device.key) {
                    if (it.status == PairedDeviceStatus.REVOKED
                        || it.status == PairedDeviceStatus.EXPIRED
                        || it.status == PairedDeviceStatus.ADDRESS_CHANGED
                    ) it else it.copy(status = PairedDeviceStatus.UNREACHABLE)
                }
                }
                showDeviceList()
            }
        }
    }

    private fun showConnectionChoices() {
        cancelRestoreEscape()
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

    private fun showRemoteSetup() {
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
        RemoteHostPolicy.isAllowed(accessMode, origin.host)

    private fun warnIfTailscale(origin: GatewayOrigin) {
        if (!RemoteHostPolicy.needsTailscaleVpnNotice(origin.host)) return
        if (!warnedTailscaleOrigins.add(origin.serialized)) return
        Toast.makeText(this, R.string.tailscale_vpn_warning, Toast.LENGTH_LONG).show()
    }

    private fun showRestoringTrust(retryDeviceKey: String? = null) {
        cancelRestoreEscape()
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
        content.addView(ProgressBar(this))
        content.addView(spacer(16))
        content.addView(textView(R.string.restoring_trust, 16f, Typeface.NORMAL, R.color.app_secondary).apply {
            gravity = Gravity.CENTER
        })
        content.addView(spacer(12))
        val escapeMessage = textView(
            if (retryDeviceKey == null) R.string.restore_taking_longer_no_retry else R.string.restore_taking_longer,
            14f,
            Typeface.NORMAL,
            R.color.app_secondary,
        ).apply {
            gravity = Gravity.CENTER
            visibility = View.GONE
        }
        content.addView(escapeMessage)
        content.addView(spacer(12))
        val escapeActions = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        if (retryDeviceKey != null) {
            escapeActions.addView(
                secondaryButton(R.string.retry, 48) { retryStartupRestore(retryDeviceKey) },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
            escapeActions.addView(spacer(8))
        }
        escapeActions.addView(
            primaryButton(R.string.restore_show_devices, 48) { showDeviceList() },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
        content.addView(escapeActions)
        root.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        applySafeAreaInsets(root)
        restoreEscapeRunnable = Runnable {
            if (!isFinishing && !isDestroyed && webView == null && !showingSetup) {
                escapeMessage.visibility = View.VISIBLE
                escapeActions.visibility = View.VISIBLE
            }
        }.also { restoreUiHandler.postDelayed(it, RESTORE_ESCAPE_DELAY_MS) }
    }

    private fun retryStartupRestore(deviceKey: String) {
        val device = ConnectionRestorePolicy.retryDevice(
            pairedDeviceStore.load(),
            deviceKey,
            System.currentTimeMillis(),
        )
        if (device == null) {
            showConnectionCenter()
            return
        }
        cancelAutomaticRecovery()
        restoreStartupDevice(device)
    }

    private fun cancelRestoreEscape() {
        restoreEscapeRunnable?.let(restoreUiHandler::removeCallbacks)
        restoreEscapeRunnable = null
    }

    private fun showPairing(harness: DiscoveredHarness, prefilledInput: String = "", autoConnect: Boolean = false) {
        cancelRestoreEscape()
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
        setContentView(root)
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
        button.isEnabled = false
        status.setTextColor(getColor(R.color.app_secondary))
        status.setText(R.string.pairing_in_progress)
        status.visibility = View.VISIBLE
        val mode = accessMode
        val store = credentialStore(mode)
        val generation = beginPairingAttempt()
        ioExecutor.execute {
            if (generation != pairingGeneration) return@execute
            val compatibility = runCatching { NativeAuthClient.fetchMetadata(origin) }
                .getOrNull()
                ?.let { VersionCompatibility.evaluate(BuildConfig.VERSION_NAME, it) }
            if (compatibility != null) {
                runOnUiThread {
                    if (generation == pairingGeneration) showCompatibilityIssue(compatibility, status, button)
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
                    NativeAuthClient.fetchPairingCa(origin)
                }
            }
            val trustFailure = trustAttempt.exceptionOrNull()
            if (trustFailure != null) {
                runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(pairingFailureMessage(trustFailure, origin))
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
                    button.isEnabled = true
                }
                return@execute
            }
            val (certificate, expectedInstanceId) = trust
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
                    )
                }
                val renewed = renewal.getOrNull()
                if (renewed != null) {
                    runOnUiThread {
                        if (generation != pairingGeneration) return@runOnUiThread
                        if (renewed.instanceId != existingCredential.instanceId) {
                            status.setTextColor(getColor(R.color.app_error))
                            status.setText(R.string.pairing_failed)
                            button.isEnabled = true
                        } else {
                            if (savePairedDevice(mode, origin, renewed, existingCredential) == null) {
                                status.setText(R.string.device_storage_unavailable); button.isEnabled = true
                                return@runOnUiThread
                            }
                            installNativeSession(
                                origin = origin,
                                session = renewed,
                                isCurrent = { generation == pairingGeneration && accessMode == mode },
                            ) { showBrowser(origin, existingCredential.caCertificate) }
                        }
                    }
                    return@execute
                }
                val renewalFailure = renewal.exceptionOrNull() ?: NativeAuthFailure(NativeAuthFailureKind.INVALID_RESPONSE)
                if (!ConnectionRestorePolicy.mayPairAfterRenewFailure(renewalFailure)) {
                    runOnUiThread {
                        if (generation != pairingGeneration) return@runOnUiThread
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(pairingFailureMessage(renewalFailure, origin))
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
                        button.isEnabled = true
                    }
                    return@execute
                }
            }
            if (generation != pairingGeneration) return@execute
            runCatching { NativeAuthClient.pair(origin, key.token, certificate, key.instanceId) }
                .onSuccess { session -> runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    val deviceToken = session.deviceToken
                    val expiresAt = session.deviceExpiresAt
                    if (deviceToken == null || expiresAt == null
                        || (expectedInstanceId != null && session.instanceId != expectedInstanceId)) {
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(R.string.pairing_failed)
                        button.isEnabled = true
                    } else if (!runCatching {
                            pairedDeviceStore.requireReadable()
                            if (!pairedDeviceStore.isMigrationComplete()) {
                                store.save(DeviceCredential(session.instanceId, deviceToken, expiresAt, certificate))
                            }
                        }.isSuccess) {
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(R.string.device_storage_unavailable)
                        button.isEnabled = true
                    } else {
                        val record = savePairedDevice(
                            mode = mode,
                            origin = origin,
                            session = session,
                            credential = DeviceCredential(session.instanceId, deviceToken, expiresAt, certificate),
                        ) ?: run {
                            status.setText(R.string.device_storage_unavailable); button.isEnabled = true
                            return@runOnUiThread
                        }
                        installNativeSession(
                            origin = origin,
                            session = session,
                            isCurrent = { generation == pairingGeneration && accessMode == mode },
                        ) {
                            if (record.displayName == localizedDefaultDeviceName(record.mode)) showPairedDeviceNamePrompt(record) { showBrowser(origin, certificate) }
                            else showBrowser(origin, certificate)
                        }
                    }
                } }
                .onFailure { error -> runOnUiThread {
                    if (generation != pairingGeneration) return@runOnUiThread
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(pairingFailureMessage(error, origin))
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
        scanCanceled.set(false)
        results.removeAllViews()
        status.setTextColor(getColor(R.color.app_secondary))
        status.setText(if (nearbyPermissionLimited) R.string.scanning_lan_limited else R.string.scanning_lan)
        status.visibility = View.VISIBLE

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
            scanCanceled.set(true)
            cancelButton.isEnabled = false
        }
        results.addView(cancelButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        ioExecutor.execute {
            val found = runCatching { LanDiscovery.scan(this, canceled = scanCanceled) }.getOrDefault(emptyList())
            runOnUiThread {
                button.isEnabled = true
                cancelButton.isEnabled = true
                cancelButton.visibility = View.GONE
                if (scanCanceled.get()) {
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
        isCurrent: () -> Boolean = { true },
        complete: () -> Unit,
    ) {
        if (!isCurrent() || session.origin != origin) return
        val cookies = CookieManager.getInstance()
        val aliases = nativeSessionCookies(session)
        fun installAlias(index: Int) {
            if (!isCurrent()) return
            if (index == aliases.size) {
                cookies.flush()
                complete()
                return
            }
            cookies.setCookie(origin.serialized, aliases[index]) {
                if (!isCurrent()) return@setCookie
                installAlias(index + 1)
            }
        }
        installAlias(0)
    }

    private fun savePairedDevice(
        mode: AccessMode,
        origin: GatewayOrigin,
        session: NativeSession,
        credential: DeviceCredential,
    ): PairedDeviceRecord? {
        dismissDeviceUndo()
        val key = "${mode.name.lowercase()}:${session.instanceId}"
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
        )
        if (withCredentialStorage { pairedDeviceStore.upsert(record) } == null) return null
        activeDeviceKey = key
        preferences.edit()
            .putString(PREFERENCE_LAST_DEVICE_KEY, key)
            .putLong(lastConnectedPreference(mode), now)
            .putString(originPreference(mode), origin.serialized)
            .apply()
        return record
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

    private fun recoverAutomatically() {
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
        val credential = legacyCredentialForRestore(mode) ?: return
        if (credential.expiresAt <= System.currentTimeMillis()) {
            withCredentialStorage { credentialStore(mode).clear() }
            return
        }
        val preferred = gatewayOrigin
            ?: GatewayOrigin.parse(preferences.getString(originPreference(mode), "").orEmpty())
            ?: return
        val generation = beginRestoreAttempt()
        restoreTrustedDevice(preferred, credential, mode, generation, preserveWebView = webView) { disposition ->
            if (disposition == RestoreFailureDisposition.RETRY_TRANSIENT) {
                if (!scheduleAutomaticRecovery()) finishAutomaticRecoveryAfterRetryBudget { showConnectionCenter() }
            } else {
                cancelAutomaticRecovery()
            }
        }
    }

    private fun canRecoverAutomatically(): Boolean {
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
        if (recoveryScheduled) return true
        if (recoveryAttempt >= RECOVERY_DELAYS_MS.size || !canRecoverAutomatically()) return false
        val delay = RECOVERY_DELAYS_MS[recoveryAttempt++]
        recoveryScheduled = true
        recoveryHandler.postDelayed({
            recoveryScheduled = false
            if (!isFinishing && !isDestroyed) recoverAutomatically()
        }, delay)
        return true
    }

    private fun cancelAutomaticRecovery() {
        recoveryHandler.removeCallbacksAndMessages(null)
        recoveryAttempt = 0
        recoveryScheduled = false
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
                ExhaustedRecoveryAction.IGNORE, ExhaustedRecoveryAction.KEEP_PAGE -> Unit
                ExhaustedRecoveryAction.SHOW_CONNECTIONS -> fallback()
            }
        }
    }

    private fun beginRestoreAttempt(): Int {
        restoreGeneration += 1
        return restoreGeneration
    }

    private fun invalidateRestoreAttempts() {
        restoreGeneration += 1
        connectionCenterStatus?.visibility = View.GONE
    }

    private fun beginPairingAttempt(): Int {
        pairingGeneration += 1
        return pairingGeneration
    }

    private fun invalidatePairingAttempts() {
        pairingGeneration += 1
    }

    private fun restoreTrustedDevice(
        preferredOrigin: GatewayOrigin,
        credential: DeviceCredential,
        mode: AccessMode = accessMode,
        generation: Int = beginRestoreAttempt(),
        deviceKey: String? = null,
        preserveWebView: WebView? = null,
        claimSuccess: () -> Boolean = { true },
        onFailure: (RestoreFailureDisposition) -> Unit,
    ) {
        val requestedDevice = deviceKey?.let { key -> pairedDeviceStore.load().firstOrNull { it.key == key } }
        if (deviceKey != null && (requestedDevice == null || requestedDevice.status == PairedDeviceStatus.REVOKED)) {
            onFailure(RestoreFailureDisposition.REQUIRE_USER_ACTION)
            return
        }
        if (!RemoteHostPolicy.isAllowed(mode, preferredOrigin.host)) {
            if (deviceKey != null) withCredentialStorage { pairedDeviceStore.update(deviceKey) {
                if (it.status == PairedDeviceStatus.REVOKED) it else it.copy(status = PairedDeviceStatus.ADDRESS_CHANGED)
            }
            } else {
                if (withCredentialStorage { credentialStore(mode).clear() } != null) {
                    preferences.edit().remove(originPreference(mode)).apply()
                }
            }
            if (generation == restoreGeneration) onFailure(RestoreFailureDisposition.REQUIRE_USER_ACTION)
            return
        }
        try {
            restoreExecutor.execute {
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
                        ).also { session ->
                            if (session.instanceId != credential.instanceId) instanceMismatch = true
                        }.takeUnless { instanceMismatch }
                    } catch (failure: Exception) {
                        lastFailure = failure
                        null
                    }
                }

                var session = renew(selectedOrigin)
                var disposition = ConnectionRestorePolicy.failureDisposition(lastFailure, instanceMismatch)
                if (generation != restoreGeneration) return@execute
                if (session == null && mode == AccessMode.LAN && disposition == RestoreFailureDisposition.RETRY_TRANSIENT) {
                    val found = runCatching { LanDiscovery.scan(this) }.getOrDefault(emptyList())
                        .singleOrNull { it.instanceId == credential.instanceId }
                    if (generation != restoreGeneration) return@execute
                    if (found != null) {
                        selectedOrigin = found.origin
                        session = renew(selectedOrigin)
                        disposition = ConnectionRestorePolicy.failureDisposition(lastFailure, instanceMismatch)
                    }
                }

                val renewed = session
                val finalDisposition = disposition
                val failureKind = (lastFailure as? NativeAuthFailure)?.kind
                runOnUiThread {
                    if (generation != restoreGeneration) return@runOnUiThread
                    if (deviceKey != null) {
                        val current = pairedDeviceStore.load().firstOrNull { it.key == deviceKey }
                        if (current == null || requestedDevice == null ||
                            !PairedDeviceStatusPolicy.mayApplyResult(current, requestedDevice)
                        ) return@runOnUiThread
                    }
                    if (renewed == null) {
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
                        onFailure(finalDisposition)
                    } else {
                        if (!claimSuccess()) return@runOnUiThread
                        accessMode = mode
                        if (savePairedDevice(mode, selectedOrigin, renewed, credential) == null) {
                            onFailure(RestoreFailureDisposition.REQUIRE_USER_ACTION)
                            return@runOnUiThread
                        }
                        warnIfTailscale(selectedOrigin)
                        cancelAutomaticRecovery()
                        installNativeSession(
                            origin = selectedOrigin,
                            session = renewed,
                            isCurrent = { generation == restoreGeneration },
                        ) {
                            if (preserveWebView == null) {
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
                }
            }
        } catch (_: RejectedExecutionException) {
            // Activity teardown owns executor shutdown; no UI result is needed afterwards.
            if (generation == restoreGeneration) onFailure(RestoreFailureDisposition.RETRY_TRANSIENT)
        }
    }

    /** The dedicated React shell appears after DSH boot; HTML completion alone is not readiness. */
    private fun probeMountedDshPage(candidate: WebView, origin: GatewayOrigin, complete: (Boolean) -> Unit) {
        if (webView !== candidate || gatewayOrigin != origin || !isDshDocumentUrl(origin, candidate.url.orEmpty())) {
            complete(false)
            return
        }
        val completed = AtomicBoolean(false)
        val timeout = Runnable { if (completed.compareAndSet(false, true)) complete(false) }
        restoreUiHandler.postDelayed(timeout, LIVE_DOCUMENT_PROBE_TIMEOUT_MS)
        runCatching {
            candidate.evaluateJavascript(MOUNTED_DSH_PROBE) { result ->
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
                RenewedDocumentAction.KEEP -> failureDialog?.dismiss()
                RenewedDocumentAction.RELOAD -> reload()
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
        showRestoringTrust(activeDeviceKey)
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
    ) {
        cancelRestoreEscape()
        if (!isOriginAllowedForAccessMode(origin)) {
            val cleared = withCredentialStorage { credentialStore().clear() } != null
            if (cleared) preferences.edit().remove(originPreference()).apply()
            showConnectionCenter()
            if (!cleared) showCredentialStorageFailure()
            return
        }
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
        val browser = WebView(this)
        configureWebViewHttpCache(browser)
        webView = browser
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
        installBrowserCompatibilityShim(browser, origin)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(browser, false)
        }
        val secureClient = SecureWebViewClient(
            origin = origin,
            caCertificate = caCertificate,
            openExternal = ::openExternal,
            onBlocked = { toastError(R.string.blocked_navigation) },
            onFailure = ::showLoadFailure,
            onRendererGone = { handleRendererGone(browser) },
            onTopLevelUrlChanged = {
                displayScale.onDocumentStarted()
                cancelPendingWebBack()
                pendingAudioPermission = null
                nativeBridge?.onTopLevelNavigation(it)
            },
            onLoaded = {
                if (webView === browser && gatewayOrigin == origin) {
                    displayScale.onDocumentReady()
                    retryUrl = origin.serialized
                    CookieManager.getInstance().flush()
                    nativeBridge?.injectPage()
                }
            },
        )
        secureWebViewClient = secureClient
        browser.webViewClient = secureClient
        browser.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean = showFileChooser(filePathCallback, fileChooserParams)

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
        nativeBridge = NativeBridge(this, browser, origin, bridgeState).also { bridge ->
            bridge.onPageBackgroundColor = { color ->
                root.setBackgroundColor(color)
                statusBarBackdrop.setBackgroundColor(color)
                applyStatusBarIconContrast(window, color)
                preferences.edit().putInt(PREFERENCE_WEB_CHROME_COLOR, color).apply()
            }
            bridge.onDeviceRevoked = ::handleDeviceRevoked
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
        setContentView(root)

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
        browser.loadUrl(initialUrl)
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
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ): Boolean {
        uploadCallback?.onReceiveValue(null)
        uploadCallback = callback
        val mimeTypes = acceptedMimeTypes(params.acceptTypes)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            type = if (mimeTypes.size == 1) mimeTypes.single() else "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
        }
        return try {
            startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_file)), FILE_CHOOSER_REQUEST)
            true
        } catch (_: ActivityNotFoundException) {
            uploadCallback?.onReceiveValue(null)
            uploadCallback = null
            false
        }
    }

    private fun finishFileSelection(resultCode: Int, data: Intent?) {
        val callback = uploadCallback ?: return
        uploadCallback = null
        if (resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return
        }
        val uris = mutableListOf<Uri>()
        data?.clipData?.let { clip: ClipData ->
            for (index in 0 until clip.itemCount) uris += clip.getItemAt(index).uri
        }
        data?.data?.let { if (it !in uris) uris += it }
        callback.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
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

    private fun showLoadFailure(failure: LoadFailure) {
        if (isFinishing || failureDialog?.isShowing == true) return
        if ((failure == LoadFailure.NETWORK || failure == LoadFailure.AUTH_EXPIRED || failure == LoadFailure.SERVICE_UNAVAILABLE)
            && canRecoverAutomatically()
        ) {
            scheduleAutomaticRecovery()
        }
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
                if ((failure == LoadFailure.NETWORK || failure == LoadFailure.AUTH_EXPIRED || failure == LoadFailure.SERVICE_UNAVAILABLE)
                    && canRecoverAutomatically()
                ) {
                    recoverAutomatically()
                } else {
                    val target = retryUrl ?: gatewayOrigin?.serialized
                    if (target != null) webView?.loadUrl(target)
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
        cancelPendingWebBack()
        secureWebViewClient?.dispose()
        secureWebViewClient = null
        pendingAudioPermission = null
        nativeBridge?.dispose(changingConfigurations)
        nativeBridge = null
        webView?.apply {
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
        const val FILE_CHOOSER_REQUEST = 4101
        const val DOWNLOAD_DESTINATION_REQUEST = 4102
        const val SCAN_CAMERA_REQUEST = 4103
        const val NEARBY_WIFI_REQUEST = 4104
        const val TASK_NOTIFICATION_PERMISSION_REQUEST = 4105
        const val SCAN_QR_REQUEST = 4106
        const val VOICE_PERMISSION_REQUEST = 4107
        const val DEVICE_STATUS_REFRESH_MS = 20_000L
        const val DEVICE_UNDO_TIMEOUT_MS = 6_000L
        const val LIVE_DOCUMENT_PROBE_TIMEOUT_MS = 2_000L
        const val MOBILE_BACK_TIMEOUT_MS = 1_500L
        const val RESTORE_ESCAPE_DELAY_MS = 12_000L
        const val APP_RELEASES_URL = "https://github.com/saya-ch/dsh-mobile/releases/latest"
        val RECOVERY_DELAYS_MS = longArrayOf(0L, 1_000L, 3_000L, 8_000L)
        val MIME_TYPE = Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+*-]+$")
        val UNSAFE_FILENAME = Regex("[\\\\/:*?\"<>|\\p{Cc}]")
    }
}
