package io.github.sayach.dshmobile

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
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
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

/** Native Android shell for one authenticated DSH HTTPS origin. */
class MainActivity : Activity() {
    private data class PendingDownload(
        val url: String,
        val userAgent: String?,
        val mimeType: String,
        val filename: String,
        val caCertificate: ByteArray?,
    )

    private val preferences by lazy { getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE) }
    private val lanCredentialStore by lazy { DeviceCredentialStore(this, "lan") }
    private val remoteCredentialStore by lazy { DeviceCredentialStore(this, "remote") }
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var webView: WebView? = null
    private var nativeBridge: NativeBridge? = null
    private var gatewayOrigin: GatewayOrigin? = null
    private var accessMode = AccessMode.LAN
    private var setupBackAction: (() -> Unit)? = null
    private var uploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingDownload: PendingDownload? = null
    private var failureDialog: AlertDialog? = null
    private var retryUrl: String? = null
    private var pendingScan: (() -> Unit)? = null
    private var showingSetup = false
    private var restoringTrustedSession = false
    private val warnedTailscaleOrigins = mutableSetOf<String>()
    // The floating toolbar starts hidden so the page's own header stays clear;
    // scrolling back up brings it in, scrolling down slides it away.
    private var toolbarHidden = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureEdgeToEdgeWindow(window)
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
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Activity back dispatch is retained for Android 12 and earlier.")
    override fun onBackPressed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) handleBack()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (nativeBridge?.onActivityResult(requestCode, resultCode, data) == true) return
        when (requestCode) {
            FILE_CHOOSER_REQUEST -> finishFileSelection(resultCode, data)
            DOWNLOAD_DESTINATION_REQUEST -> finishDownloadSelection(resultCode, data)
            SCAN_QR_REQUEST -> finishScanResult(resultCode, data)
        }
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onPause() {
        webView?.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        failureDialog?.dismiss()
        uploadCallback?.onReceiveValue(null)
        uploadCallback = null
        retryUrl = null
        destroyWebView()
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun handleBack() {
        val currentWebView = webView
        if (currentWebView != null && currentWebView.canGoBack()) {
            currentWebView.goBack()
        } else if (setupBackAction != null) {
            setupBackAction?.invoke()
        } else {
            finish()
        }
    }

    private fun credentialStore(): DeviceCredentialStore = when (accessMode) {
        AccessMode.LAN -> lanCredentialStore
        AccessMode.REMOTE -> remoteCredentialStore
    }

    private fun originPreference(): String = when (accessMode) {
        AccessMode.LAN -> PREFERENCE_LAN_ORIGIN
        AccessMode.REMOTE -> PREFERENCE_REMOTE_ORIGIN
    }

    private fun restoreColdStartConnection(preferredMode: AccessMode?) {
        val targets = ConnectionRestorePolicy.targets(
            preferredMode = preferredMode,
            lanOrigin = preferences.getString(PREFERENCE_LAN_ORIGIN, null),
            lanCredential = lanCredentialStore.load(),
            remoteOrigin = preferences.getString(PREFERENCE_REMOTE_ORIGIN, null),
            remoteCredential = remoteCredentialStore.load(),
            now = System.currentTimeMillis(),
        )
        if (targets.isEmpty()) {
            showConnectionCenter()
            return
        }
        showRestoringTrust()
        restoreColdStartTarget(targets, 0)
    }

    private fun restoreColdStartTarget(targets: List<ConnectionRestoreTarget>, index: Int) {
        val target = targets.getOrNull(index)
        if (target == null) {
            showConnectionCenter()
            return
        }
        accessMode = target.mode
        restoreTrustedDevice(target.origin, target.credential) {
            restoreColdStartTarget(targets, index + 1)
        }
    }

    private fun showConnectionCenter() {
        showingSetup = true
        setupBackAction = null
        gatewayOrigin = null
        retryUrl = null
        destroyWebView()
        failureDialog?.dismiss()

        val card = createSetupCard(surface = false)
        card.addView(textView(R.string.connection_center_title, 30f, Typeface.BOLD))
        card.addView(spacer(8))
        card.addView(textView(R.string.connection_center_description, 16f, Typeface.NORMAL, R.color.app_secondary))
        card.addView(spacer(24))
        card.addView(accessChoice(
            R.string.lan_access_title,
            R.string.lan_access_description,
            lanCredentialStore.load()?.expiresAt?.let { it > System.currentTimeMillis() } == true,
        ) { openAccessMode(AccessMode.LAN) })
        card.addView(spacer(12))
        card.addView(accessChoice(
            R.string.remote_access_title,
            R.string.remote_access_description,
            remoteCredentialStore.load()?.expiresAt?.let { it > System.currentTimeMillis() } == true,
        ) { openAccessMode(AccessMode.REMOTE) })
    }

    private fun accessChoice(titleResource: Int, descriptionResource: Int, trusted: Boolean, action: () -> Unit): View =
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
                addView(textView(R.string.paired_device_ready, 13f, Typeface.BOLD, R.color.app_accent))
            }
            setOnClickListener { action() }
        }

    private fun openAccessMode(mode: AccessMode) {
        accessMode = mode
        val origin = GatewayOrigin.parse(preferences.getString(originPreference(), "").orEmpty())
        val credential = credentialStore().load()
        if (origin != null && credential != null && credential.expiresAt > System.currentTimeMillis()) {
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

    private fun isRemoteTunnelHost(host: String): Boolean = RemoteHostPolicy.isSupported(host)

    private fun isOriginAllowedForAccessMode(origin: GatewayOrigin): Boolean =
        RemoteHostPolicy.isAllowed(accessMode, origin.host)

    private fun warnIfTailscale(origin: GatewayOrigin) {
        if (!RemoteHostPolicy.needsTailscaleVpnNotice(origin.host)) return
        if (!warnedTailscaleOrigins.add(origin.serialized)) return
        Toast.makeText(this, R.string.tailscale_vpn_warning, Toast.LENGTH_LONG).show()
    }

    private fun showRestoringTrust() {
        showingSetup = false
        setupBackAction = null
        destroyWebView()
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
        root.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        applySafeAreaInsets(root)
    }

    private fun showPairing(harness: DiscoveredHarness, prefilledInput: String = "", autoConnect: Boolean = false) {
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
        setContentView(root)
        applySafeAreaInsets(root)
        return card
    }

    /** Pre-connection artwork: covers the whole screen (edges may crop), under a translucent white scrim. */
    private fun addSetupArtwork(root: FrameLayout) {
        root.addView(
            ImageView(this).apply {
                setImageResource(R.drawable.setup_background_image)
                scaleType = ImageView.ScaleType.CENTER_CROP
            },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        root.addView(
            View(this).apply { setBackgroundColor(0x99FFFFFF.toInt()) },
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
        val credential = credentialStore().load()
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
        ioExecutor.execute {
            val trust: Pair<ByteArray?, String?>? = if (accessMode == AccessMode.REMOTE) {
                null to key.instanceId
            } else {
                val rawCa = runCatching { NativeAuthClient.fetchPairingCa(origin) }.getOrNull()
                rawCa?.let { ca -> PairingTrust.validateCertificate(ca, key.instanceId)?.let { it to key.instanceId } }
            }
            if (trust == null) {
                runOnUiThread {
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(R.string.pairing_tls_failed)
                    button.isEnabled = true
                }
                return@execute
            }
            val (certificate, expectedInstanceId) = trust
            runCatching { NativeAuthClient.pair(origin, key.token, certificate) }
                .onSuccess { session -> runOnUiThread {
                    val deviceToken = session.deviceToken
                    val expiresAt = session.deviceExpiresAt
                    if (deviceToken == null || expiresAt == null
                        || (expectedInstanceId != null && session.instanceId != expectedInstanceId)) {
                        status.setTextColor(getColor(R.color.app_error))
                        status.setText(R.string.pairing_failed)
                        button.isEnabled = true
                    } else {
                        credentialStore().save(DeviceCredential(session.instanceId, deviceToken, expiresAt, certificate))
                        installNativeSession(origin, session) { showBrowser(origin, certificate) }
                    }
                } }
                .onFailure { runOnUiThread {
                    status.setTextColor(getColor(R.color.app_error))
                    status.setText(R.string.pairing_failed)
                    button.isEnabled = true
                } }
        }
    }

    private var scanCanceled = AtomicBoolean(false)

    private fun scanForHarnesses(status: TextView, button: Button, results: LinearLayout) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
            pendingScan = { scanForHarnesses(status, button, results) }
            requestPermissions(arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES), NEARBY_WIFI_REQUEST)
            return
        }
        button.isEnabled = false
        scanCanceled.set(false)
        results.removeAllViews()
        status.setTextColor(getColor(R.color.app_secondary))
        status.setText(R.string.scanning_lan)
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
                        val trustedCredential = lanCredentialStore.load()?.takeIf {
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
        when (requestCode) {
            NEARBY_WIFI_REQUEST -> {
                val retry = pendingScan
                pendingScan = null
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) retry?.invoke()
            }
            SCAN_CAMERA_REQUEST -> {
                if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startScanActivity()
                else toastError(R.string.scan_camera_denied)
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
        val target = PairingScanPolicy.parse(text)
        if (target != null) {
            accessMode = target.mode
            showPairing(manualHarness(target.connection.origin), prefilledInput = text, autoConnect = true)
            return
        }
        toastError(R.string.scan_result_invalid)
    }

    private fun installNativeSession(origin: GatewayOrigin, session: NativeSession, complete: () -> Unit) {
        val cookies = CookieManager.getInstance()
        cookies.setCookie(origin.serialized, "dsh_ma_session=${session.sessionToken}; Path=/; Secure; HttpOnly; SameSite=Strict") {
            cookies.setCookie(origin.serialized, "dsh_ma_csrf=${session.csrfToken}; Path=/; Secure; SameSite=Strict") {
                cookies.flush()
                complete()
            }
        }
    }

    private fun recoverAutomatically() {
        val credential = credentialStore().load() ?: return
        if (credential.expiresAt <= System.currentTimeMillis()) {
            credentialStore().clear()
            return
        }
        val preferred = gatewayOrigin
            ?: GatewayOrigin.parse(preferences.getString(originPreference(), "").orEmpty())
            ?: return
        restoreTrustedDevice(preferred, credential) {}
    }

    private fun restoreTrustedDevice(
        preferredOrigin: GatewayOrigin,
        credential: DeviceCredential,
        onFailure: () -> Unit,
    ) {
        if (restoringTrustedSession) return
        if (!isOriginAllowedForAccessMode(preferredOrigin)) {
            preferences.edit().remove(originPreference()).apply()
            credentialStore().clear()
            onFailure()
            return
        }
        warnIfTailscale(preferredOrigin)
        restoringTrustedSession = true
        ioExecutor.execute {
            var selectedOrigin = preferredOrigin
            var session = runCatching {
                NativeAuthClient.renew(selectedOrigin, credential.deviceToken, credential.caCertificate)
            }.getOrNull()
            if (session?.instanceId != credential.instanceId) session = null
            if (session == null && accessMode == AccessMode.LAN) {
                val found = runCatching { LanDiscovery.scan(this) }.getOrDefault(emptyList())
                    .singleOrNull { it.instanceId == credential.instanceId }
                if (found != null) {
                    selectedOrigin = found.origin
                    session = runCatching {
                        NativeAuthClient.renew(selectedOrigin, credential.deviceToken, credential.caCertificate)
                    }.getOrNull()?.takeIf { it.instanceId == credential.instanceId }
                }
            }
            val renewed = session
            runOnUiThread {
                restoringTrustedSession = false
                if (renewed == null) {
                    onFailure()
                } else {
                    failureDialog?.dismiss()
                    installNativeSession(selectedOrigin, renewed) {
                        showBrowser(selectedOrigin, credential.caCertificate)
                    }
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showBrowser(
        origin: GatewayOrigin,
        caCertificate: ByteArray?,
        requestedInitialUrl: String = origin.serialized,
    ) {
        if (!isOriginAllowedForAccessMode(origin)) {
            preferences.edit().remove(originPreference()).apply()
            credentialStore().clear()
            showConnectionCenter()
            return
        }
        showingSetup = false
        setupBackAction = null
        gatewayOrigin = origin
        preferences.edit()
            .putString(originPreference(), origin.serialized)
            .putString(PREFERENCE_LAST_ACCESS_MODE, accessMode.name)
            .apply()

        // The toolbar floats above a full-screen WebView so the page can use the
        // whole screen while it scrolls; the mobile layout owns its safe-area
        // insets itself (viewport-fit=cover + env(safe-area-inset-top)).
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.app_background))
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(4), 0)
            setBackgroundColor(getColor(R.color.app_surface))
            elevation = dp(2).toFloat()
        }
        val title = textView(R.string.toolbar_title, 16f, Typeface.BOLD).apply {
            gravity = Gravity.CENTER_VERTICAL
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        val refresh = toolbarIconButton(R.drawable.ic_refresh, R.string.refresh)
        val more = toolbarIconButton(R.drawable.ic_more_vertical, R.string.more)
        bar.addView(refresh, LinearLayout.LayoutParams(dp(40), dp(40)))
        bar.addView(more, LinearLayout.LayoutParams(dp(40), dp(40)))

        val loading = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
            progressTintList = ColorStateList.valueOf(getColor(R.color.app_accent))
        }

        val browser = WebView(this)
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
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString DSHMobile/0.1"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(browser, false)
        }
        browser.webViewClient = SecureWebViewClient(
            origin = origin,
            caCertificate = caCertificate,
            openExternal = ::openExternal,
            onBlocked = { toastError(R.string.blocked_navigation) },
            onFailure = ::showLoadFailure,
            onLoaded = {
                if (webView === browser && gatewayOrigin == origin) {
                    retryUrl = origin.serialized
                    CookieManager.getInstance().flush()
                    nativeBridge?.injectPage()
                }
            },
        )
        browser.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                loading.progress = newProgress
                loading.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean = showFileChooser(filePathCallback, fileChooserParams)

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }
        }
        nativeBridge?.dispose()
        nativeBridge = NativeBridge(this, browser, origin.serialized).also { it.install() }
        nativeBridge?.onScrollDirection = { direction -> animateToolbar(direction, bar, loading) }
        browser.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            requestDownload(origin, caCertificate, url, userAgent, contentDisposition, mimeType)
        }
        root.addView(browser, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48), Gravity.TOP))
        root.addView(loading, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP))
        setContentView(root)

        // Keep the toolbar clear of the status bar; the loading bar sits below it.
        root.setOnApplyWindowInsetsListener { _, insets ->
            val top = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(WindowInsets.Type.statusBars()).top
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetTop
            }
            bar.setPadding(dp(16), top, dp(4), 0)
            bar.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48) + top, Gravity.TOP)
            loading.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP).apply {
                topMargin = dp(48) + top
            }
            bar.translationY = if (toolbarHidden) -(dp(48) + top).toFloat() else 0f
            bar.alpha = if (toolbarHidden) 0f else 1f
            loading.translationY = bar.translationY
            loading.alpha = bar.alpha
            // Pass the insets through instead of consuming them: the full-screen
            // WebView computes env(safe-area-inset-top/bottom) from them, which
            // keeps the page's own header clear of the status bar.
            insets
        }
        root.requestApplyInsets()

        refresh.setOnClickListener { browser.reload() }

        more.setOnClickListener {
            PopupMenu(this, more).apply {
                menu.add(0, MENU_SHARE, 0, R.string.share)
                menu.add(0, MENU_EDIT_CONNECTION, 1, R.string.edit_connection)
                menu.add(0, MENU_CLEAR_DATA, 2, R.string.clear_site_data)
                setOnMenuItemClickListener { item ->
                    when (item.itemId) {
                        MENU_SHARE -> {
                            shareGateway(origin)
                            true
                        }

                        MENU_EDIT_CONNECTION -> {
                            showConnectionCenter()
                            true
                        }

                        MENU_CLEAR_DATA -> {
                            confirmClearSiteData()
                            true
                        }

                        else -> false
                    }
                }
                show()
            }
        }
        val initialUrl = requestedInitialUrl.takeIf { GatewayUrlPolicy.isSameOrigin(origin, it) }
            ?: origin.serialized
        retryUrl = initialUrl
        browser.loadUrl(initialUrl)
    }

    /** Slide the floating toolbar out of view while the page scrolls down. */
    private fun animateToolbar(direction: String, bar: View, loading: View) {
        val hide = direction == "down"
        if (hide == toolbarHidden) return
        toolbarHidden = hide
        val offset = bar.height.toFloat()
        if (offset <= 0f) return
        val duration = 180L
        bar.animate().translationY(if (hide) -offset else 0f).alpha(if (hide) 0f else 1f).setDuration(duration).start()
        loading.animate().translationY(if (hide) -offset else 0f).alpha(if (hide) 0f else 1f).setDuration(duration).start()
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
        pendingDownload = PendingDownload(url, userAgent, safeMime, sanitizeFilename(guessed), caCertificate)
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
        val origin = gatewayOrigin
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
        lanCredentialStore.clear()
        remoteCredentialStore.clear()
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
        if (failure == LoadFailure.NETWORK && credentialStore().load() != null) recoverAutomatically()
        val title = if (failure == LoadFailure.TLS) {
            R.string.secure_connection_failed
        } else {
            R.string.page_load_failed
        }
        val message = if (failure == LoadFailure.TLS) {
            R.string.secure_connection_failed_message
        } else {
            R.string.page_load_failed_message
        }
        failureDialog = AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton(R.string.retry) { _, _ ->
                val target = retryUrl ?: gatewayOrigin?.serialized
                if (target != null) webView?.loadUrl(target)
            }
            .setNegativeButton(R.string.edit_connection) { _, _ ->
                showConnectionCenter()
            }
            .create()
            .also { dialog ->
                dialog.setOnDismissListener { failureDialog = null }
                dialog.show()
            }
    }

    private fun destroyWebView() {
        nativeBridge?.dispose()
        nativeBridge = null
        webView?.apply {
            stopLoading()
            webChromeClient = null
            webViewClient = android.webkit.WebViewClient()
            (parent as? ViewGroup)?.removeView(this)
            removeAllViews()
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
        const val STATE_SHOWING_SETUP = "showing_setup"
        const val STATE_ACCESS_MODE = "access_mode"
        const val FILE_CHOOSER_REQUEST = 4101
        const val DOWNLOAD_DESTINATION_REQUEST = 4102
        const val SCAN_CAMERA_REQUEST = 4103
        const val NEARBY_WIFI_REQUEST = 4104
        const val SCAN_QR_REQUEST = 4106
        const val MENU_EDIT_CONNECTION = 1
        const val MENU_CLEAR_DATA = 2
        const val MENU_SHARE = 3
        val MIME_TYPE = Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+*-]+$")
        val UNSAFE_FILENAME = Regex("[\\\\/:*?\"<>|\\p{Cc}]")
    }
}
