package io.github.sayach.dshmobile

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.util.Base64
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Exact-origin, main-frame Android capability channel. The page receives an
 * androidx.webkit WebMessage endpoint; no Java object methods are exposed.
 *
 * Security regression markers intentionally retained for the release checker:
 * addJavascriptInterface and @JavascriptInterface must never be used here.
 */
internal class NativeBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val origin: GatewayOrigin,
    restoredState: Bundle? = null,
) {
    private data class Pending(
        val action: String,
        val replyProxy: JavaScriptReplyProxy,
    )

    /** A notification request waiting for the Android runtime permission. */
    private data class PendingNotification(
        val requestId: String,
        val title: String,
        val body: String,
        val tag: String,
    )

    /** Restored operations have no surviving JavaScript caller and are cleanup-only tombstones. */
    private data class RestoredOperation(
        val requestId: String,
        val action: String,
        val processing: Boolean,
        val cameraFile: File?,
        val cameraUri: Uri?,
        val deadlineMillis: Long,
    ) {
        val disposition = RestoredOperationDisposition.CLEANUP_ONLY
    }

    private data class ActivityResultTarget(
        val requestId: String,
        val action: String,
        val cameraFile: File?,
        val cameraUri: Uri?,
        val resultUri: Uri?,
        val deadlineMillis: Long,
    )

    private data class TimedOutOperation(
        val pending: Pending?,
        val cameraFile: File?,
        val cameraUris: List<Uri>,
        val pickerUri: Uri?,
    )

    private data class DisposedTemporaryResources(
        val cameraFiles: List<File>,
        val cameraUris: List<Uri>,
        val pickerUri: Uri?,
    )

    private class PayloadTooLargeException : Exception()

    private class OwnedByteArrayOutputStream(capacity: Int) : ByteArrayOutputStream(capacity) {
        fun takeBytes(): ByteArray = if (count == buf.size) buf else buf.copyOf(count)
    }

    private val pending = PendingRequestRegistry<Pending>(MAX_PENDING)
    private val requestLock = Any()
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var activityRequestId: String? = null
    private var activityDeadlineRequestId: String? = null
    private var activityDeadlineMillis: Long? = null
    private var activityTimeoutRunnable: Runnable? = null
    private var cameraOutputFile: File? = null
    private var cameraOutputUri: Uri? = null
    private var pendingNotification: PendingNotification? = null
    private var processingTarget: ActivityResultTarget? = null
    private var restoredOperation: RestoredOperation? = null
    private val cameraCleanupOwnership = CameraCleanupOwnership<File>()
    private val pickerGrantOwnership = TemporaryGrantOwnership<Uri>()
    @Volatile private var installed = false
    @Volatile private var preservingForConfiguration = false

    init {
        restoreState(restoredState)
        val activeCameraFile = cameraOutputFile ?: processingTarget?.cameraFile ?: restoredOperation?.cameraFile
        ioExecutor.execute {
            val now = System.currentTimeMillis()
            File(activity.cacheDir, CAMERA_CACHE_DIRECTORY).listFiles()?.forEach { file ->
                if (NativeBridgePolicy.isStaleCameraOrphan(file, activeCameraFile, now)) file.delete()
            }
        }
    }

    /** Directional page-scroll observer set by the shell; reports "up" or "down". */
    var onScrollDirection: ((direction: String) -> Unit)? = null

    /** Opaque DSH base background reported after theme resolution. */
    var onPageBackgroundColor: ((color: Int) -> Unit)? = null

    /** Install the origin-scoped WebMessage channel and page-side Promise adapter. */
    fun install(): Boolean {
        if (installed) return true
        val restored = synchronized(requestLock) { restoredOperation }
        if (restored?.processing == true) cleanupRestoredOperation(restored)
        else restored?.let { scheduleActivityTimeout(it.requestId, it.deadlineMillis) }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(
            webView,
            JS_OBJECT_NAME,
            setOf(origin.serialized),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    replyProxy: JavaScriptReplyProxy,
                ) {
                    if (!installed || view !== webView) return
                    if (!NativeBridgePolicy.isTrustedMessage(origin, sourceOrigin.toString(), isMainFrame)) return
                    handleMessage(message.data, replyProxy)
                }
            },
        )
        installed = true
        injectPage()
        return true
    }

    /** Update navigation state; origin enforcement itself comes from each message callback. */
    fun onTopLevelNavigation(url: String) {
        if (!GatewayUrlPolicy.isSameOrigin(origin, url)) return
    }

    /** (Re)inject the adapter only into the configured exact-origin top-level page. */
    fun injectPage() {
        webView.post {
            if (!installed || !GatewayUrlPolicy.isSameOrigin(origin, webView.url ?: origin.serialized)) return@post
            runCatching { webView.evaluateJavascript(pageAdapterScript(), null) }
        }
    }

    /** Persist one cleanup obligation; a recreated page never inherits the destroyed JS caller. */
    fun saveState(): Bundle? = synchronized(requestLock) { stateBundleLocked(markSnapshot = true) }

    /**
     * Freeze the old owner at the actual configuration handoff and return its latest
     * state. This non-configuration snapshot supersedes the earlier saved-state copy.
     */
    fun handoffForConfiguration(): Bundle? {
        val (state, pickerUri) = synchronized(requestLock) {
            preservingForConfiguration = true
            val snapshot = stateBundleLocked(markSnapshot = true) ?: cameraCleanupOwnership.takeDeferredForHandoff()?.let { file ->
                operationStateBundle(
                    requestId = RESTORED_CLEANUP_REQUEST_ID,
                    action = "camera.capture",
                    processing = true,
                    cameraFile = file,
                    cameraUri = null,
                    deadlineMillis = System.currentTimeMillis(),
                )
            }
            cancelActivityTimeoutLocked()
            snapshot to pickerGrantOwnership.releaseAny()
        }
        revokePickerGrant(pickerUri)
        ioExecutor.shutdownNow()
        return state
    }

    private fun stateBundleLocked(markSnapshot: Boolean): Bundle? {
        restoredOperation?.let { restored ->
            return operationStateBundle(
                restored.requestId,
                restored.action,
                restored.processing,
                restored.cameraFile,
                restored.cameraUri,
                restored.deadlineMillis,
            )
        }
        val activeId = activityRequestId
        val processing = processingTarget
        if (activeId == null && processing == null) return null
        val requestId = activeId ?: processing!!.requestId
        val action = pending[requestId]?.action ?: processing?.action ?: return null
        if (markSnapshot) cameraCleanupOwnership.markSnapshotExported()
        return operationStateBundle(
            requestId,
            action,
            processing != null,
            cameraOutputFile ?: processing?.cameraFile,
            cameraOutputUri ?: processing?.cameraUri,
            processing?.deadlineMillis
                ?: activityDeadlineMillis
                ?: NativeBridgePolicy.resolveActivityDeadline(0L, System.currentTimeMillis()),
        )
    }

    /** Release snapshot deletion deferral when this same Activity survives and resumes. */
    fun onHostResumed() {
        val cleanup = synchronized(requestLock) { cameraCleanupOwnership.onHostResumed() }
        cleanup?.delete()
    }

    /**
     * Reject normal disposal, but preserve an active external capture/grant across
     * a configuration recreation. A final disposal always revokes and deletes it.
     */
    fun dispose(changingConfigurations: Boolean = false) {
        installed = false
        // onSaveInstanceState transfers any camera path before config teardown;
        // therefore config disposal must never let this old Activity reclaim deletion.
        preservingForConfiguration = changingConfigurations
        runCatching {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.removeWebMessageListener(webView, JS_OBJECT_NAME)
            }
        }
        onPageBackgroundColor = null
        onScrollDirection = null

        val temporaryResources = synchronized(requestLock) {
            cancelActivityTimeoutLocked()
            activityDeadlineRequestId = null
            activityDeadlineMillis = null
            val preservedId = if (preservingForConfiguration) {
                activityRequestId ?: processingTarget?.requestId ?: restoredOperation?.requestId
            } else null
            pending.keys().filter { it != preservedId }.forEach { pending.remove(it) }
            if (preservingForConfiguration) {
                DisposedTemporaryResources(
                    cameraCleanupOwnership.onDispose(null, true),
                    emptyList(),
                    pickerGrantOwnership.releaseAny(),
                )
            } else {
                pending.clear()
                activityRequestId = null
                pendingNotification = null
                val processing = processingTarget
                val restored = restoredOperation
                processingTarget = null
                restoredOperation = null
                val activeFile = cameraOutputFile ?: processing?.cameraFile ?: restored?.cameraFile
                val uris = listOfNotNull(cameraOutputUri, processing?.cameraUri, restored?.cameraUri).distinct()
                cameraOutputFile = null
                cameraOutputUri = null
                DisposedTemporaryResources(
                    cameraCleanupOwnership.onDispose(activeFile, false),
                    uris,
                    pickerGrantOwnership.releaseAny(),
                )
            }
        }
        temporaryResources.cameraUris.forEach(::revokeCameraGrant)
        revokePickerGrant(temporaryResources.pickerUri)
        temporaryResources.cameraFiles.forEach { it.delete() }
        ioExecutor.shutdownNow()
    }

    /** Forward Activity Result callbacks for bridge-owned system pickers. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (!isBridgeRequestCode(requestCode)) return false
        val pickerResultUri = data?.data.takeIf { requestCode == FILE_REQUEST }
        if (preservingForConfiguration) {
            revokePickerGrant(pickerResultUri)
            return true
        }
        takeRestoredOperation(requestCode)?.let { restored ->
            revokePickerGrant(pickerResultUri)
            cleanupRestoredOperation(restored)
            return true
        }
        val target = takeActivityResult(requestCode, data?.data)
        if (target == null) {
            revokePickerGrant(pickerResultUri)
            return true
        }
        revokeCameraGrant(target.cameraUri)
        if (resultCode != Activity.RESULT_OK) {
            revokePickerGrant(takePickerGrant(target))
            finishPending(
                target.requestId,
                errorJson("cancelled", "operation cancelled", target.requestId),
                target.cameraFile,
            )
            return true
        }
        queueResultRead(target)
        return true
    }

    /** Continue a bridge-owned camera request after Android runtime permission. */
    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray): Boolean {
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) return onNotificationPermissionResult(grantResults)
        if (requestCode != CAMERA_PERMISSION_REQUEST) return false
        if (preservingForConfiguration) return true
        synchronized(requestLock) {
            restoredOperation?.takeIf { it.action == "camera.capture" && it.cameraFile == null }
                ?.also { restoredOperation = null }
        }?.let {
            cleanupRestoredOperation(it)
            return true
        }
        val requestId = synchronized(requestLock) {
            activityRequestId?.takeIf { pending[it]?.action == "camera.capture" }
        } ?: return true
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
            synchronized(requestLock) { activityRequestId = null }
            finishPending(requestId, errorJson("permission_denied", "camera permission was denied", requestId))
            return true
        }
        activity.runOnUiThread {
            try {
                startCameraCapture()
            } catch (_: Exception) {
                failLaunch(requestId, "camera.capture")
            }
        }
        return true
    }

    private fun handleMessage(raw: String?, replyProxy: JavaScriptReplyProxy) {
        if (raw == null || !NativeBridgePolicy.isMessageWithinLimit(raw, MAX_MESSAGE_BYTES)) {
            postDirectReply(replyProxy, errorJson("bad_message", "message exceeds the bridge limit", ""))
            return
        }
        val parsed = try {
            JSONObject(raw)
        } catch (_: Exception) {
            postDirectReply(replyProxy, errorJson("bad_message", "message is invalid", ""))
            return
        }
        if (parsed.optInt("version", 0) != 1) {
            postDirectReply(replyProxy, errorJson("bad_message", "unsupported version", ""))
            return
        }
        if (parsed.has("event")) {
            handlePageEvent(parsed)
            return
        }

        val requestId = parsed.optString("requestId", "")
        val action = parsed.optString("action", "")
        if (requestId.isBlank() || requestId.length > MAX_REQUEST_ID_CHARS || action.isBlank()) {
            postDirectReply(replyProxy, errorJson("bad_message", "message is invalid", requestId))
            return
        }
        if (!pending.reserve(requestId, Pending(action, replyProxy))) {
            postDirectReply(replyProxy, errorJson("bad_message", "duplicate request or bridge is busy", requestId))
            return
        }

        val input = parsed.optJSONObject("input") ?: JSONObject()
        try {
            when (action) {
                "files.pick" -> startActivityPending(requestId, action) { startFilePicker(input) }
                "camera.capture" -> startActivityPending(requestId, action) { startCamera() }
                "share" -> activity.runOnUiThread {
                    try {
                        activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, input.optString("text", ""))
                        }, activity.getString(R.string.share)))
                        finishPending(requestId, successJson(requestId, JSONObject().put("ok", true)))
                    } catch (_: Exception) {
                        finishPending(requestId, errorJson("failed", "native operation failed", requestId))
                    }
                }
                "clipboard.read" -> startClipboardRead(requestId)
                "clipboard.write" -> startClipboardWrite(requestId, input.optString("text", ""))
                "notification.notify" -> startTaskNotification(requestId, input)
                else -> finishPending(requestId, errorJson("unsupported", "native capability is unavailable", requestId))
            }
        } catch (_: Exception) {
            finishPending(requestId, errorJson("failed", "native operation failed", requestId))
        }
    }

    private fun handlePageEvent(message: JSONObject) {
        when (message.optString("event")) {
            "page.scroll" -> {
                val direction = message.optString("direction")
                if (direction == "up" || direction == "down") {
                    activity.runOnUiThread { if (installed) onScrollDirection?.invoke(direction) }
                }
            }
            "page.background" -> {
                val red = message.optInt("red", -1)
                val green = message.optInt("green", -1)
                val blue = message.optInt("blue", -1)
                if (red in 0..255 && green in 0..255 && blue in 0..255) {
                    val color = Color.rgb(red, green, blue)
                    activity.runOnUiThread { if (installed) onPageBackgroundColor?.invoke(color) }
                }
            }
        }
    }

    private fun startActivityPending(requestId: String, action: String, launch: () -> Unit) {
        synchronized(requestLock) {
            if (activityRequestId != null || processingTarget != null) {
                finishPending(requestId, errorJson("busy", "another native interaction is active", requestId))
                return
            }
            activityRequestId = requestId
            scheduleActivityTimeoutLocked(
                requestId,
                NativeBridgePolicy.resolveActivityDeadline(0L, System.currentTimeMillis()),
            )
        }
        activity.runOnUiThread {
            try {
                if (!installed || preservingForConfiguration) throw IllegalStateException("bridge unavailable")
                launch()
            } catch (_: Exception) {
                failLaunch(requestId, action)
            }
        }
    }

    private fun scheduleActivityTimeout(requestId: String, deadlineMillis: Long) {
        synchronized(requestLock) { scheduleActivityTimeoutLocked(requestId, deadlineMillis) }
    }

    private fun scheduleActivityTimeoutLocked(requestId: String, deadlineMillis: Long) {
        cancelActivityTimeoutLocked()
        activityDeadlineRequestId = requestId
        activityDeadlineMillis = deadlineMillis
        val task = Runnable { timeoutActivityOperation(requestId) }
        activityTimeoutRunnable = task
        timeoutHandler.postDelayed(
            task,
            NativeBridgePolicy.remainingActivityTimeout(deadlineMillis, System.currentTimeMillis()),
        )
    }

    private fun cancelActivityTimeoutLocked() {
        activityTimeoutRunnable?.let(timeoutHandler::removeCallbacks)
        activityTimeoutRunnable = null
    }

    private fun timeoutActivityOperation(requestId: String) {
        val terminal = synchronized(requestLock) {
            if (preservingForConfiguration || activityDeadlineRequestId != requestId) return
            val processing = processingTarget?.takeIf { it.requestId == requestId }
            val restored = restoredOperation?.takeIf { it.requestId == requestId }
            if (activityRequestId != requestId && processing == null && restored == null) return

            activityRequestId = null
            if (processing != null) processingTarget = null
            if (restored != null) restoredOperation = null
            val file = cameraOutputFile ?: processing?.cameraFile ?: restored?.cameraFile
            val uris = listOfNotNull(cameraOutputUri, processing?.cameraUri, restored?.cameraUri).distinct()
            cameraOutputFile = null
            cameraOutputUri = null
            val call = pending.remove(requestId)
            val deleteNow = cameraCleanupOwnership.onTerminal(file)
            val pickerUri = pickerGrantOwnership.releaseAny()
            cancelActivityTimeoutLocked()
            activityDeadlineRequestId = null
            activityDeadlineMillis = null
            TimedOutOperation(call, deleteNow, uris, pickerUri)
        }

        terminal.cameraUris.forEach(::revokeCameraGrant)
        revokePickerGrant(terminal.pickerUri)
        terminal.cameraFile?.delete()
        terminal.pending?.let { call ->
            val body = errorJson("timeout", "native interaction timed out", requestId)
            webView.post {
                if (installed && !preservingForConfiguration) runCatching { call.replyProxy.postMessage(body) }
            }
        }
    }

    private fun startClipboardRead(requestId: String) {
        activity.runOnUiThread {
            try {
                val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val item = manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
                executeIo(requestId) {
                    val text = clipboardTextBounded(requestId, item)
                    successJson(requestId, JSONObject().put("text", text))
                }
            } catch (_: Exception) {
                finishPending(requestId, errorJson("failed", "native operation failed", requestId))
            }
        }
    }

    private fun clipboardTextBounded(requestId: String, item: ClipData.Item?): String {
        if (item == null) return ""
        val text = when {
            item.text != null -> item.text.toString()
            item.uri != null -> withActiveOperation(requestId) {
                activity.contentResolver.openInputStream(item.uri)
            }?.use { input ->
                String(readBounded(requestId, input, null, NativeBridgePolicy.MAX_CLIPBOARD_BYTES), Charsets.UTF_8)
            }.orEmpty()
            item.intent != null -> item.intent.toUri(Intent.URI_INTENT_SCHEME)
            else -> ""
        }
        if (!NativeBridgePolicy.isMessageWithinLimit(text, NativeBridgePolicy.MAX_CLIPBOARD_BYTES)) {
            throw PayloadTooLargeException()
        }
        return text
    }

    private fun startClipboardWrite(requestId: String, text: String) {
        if (!NativeBridgePolicy.isMessageWithinLimit(text, NativeBridgePolicy.MAX_CLIPBOARD_BYTES)) {
            finishPending(requestId, errorJson("payload_too_large", "clipboard text is too large", requestId))
            return
        }
        activity.runOnUiThread {
            try {
                val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                manager.setPrimaryClip(ClipData.newPlainText("DSH Mobile", text))
                finishPending(requestId, successJson(requestId, JSONObject().put("ok", true)))
            } catch (_: Exception) {
                finishPending(requestId, errorJson("failed", "native operation failed", requestId))
            }
        }
    }

    private fun executeIo(requestId: String, body: () -> String) {
        runCatching {
            ioExecutor.execute {
                try {
                    finishPending(requestId, body())
                } catch (_: PayloadTooLargeException) {
                    finishPending(requestId, errorJson("payload_too_large", "native payload is too large", requestId))
                } catch (_: Exception) {
                    finishPending(requestId, errorJson("failed", "native operation failed", requestId))
                }
            }
        }.onFailure {
            finishPending(requestId, errorJson("unavailable", "bridge is unavailable", requestId))
        }
    }

    private fun failLaunch(requestId: String, action: String) {
        val (cameraFile, cameraUri) = synchronized(requestLock) {
            if (activityRequestId != requestId || pending[requestId]?.action != action) return
            activityRequestId = null
            val file = cameraOutputFile
            val uri = cameraOutputUri
            cameraOutputFile = null
            cameraOutputUri = null
            file to uri
        }
        revokeCameraGrant(cameraUri)
        finishPending(requestId, errorJson("failed", "native operation failed", requestId), cameraFile)
    }

    private fun takeActivityResult(requestCode: Int, resultUri: Uri?): ActivityResultTarget? = synchronized(requestLock) {
        val requestId = activityRequestId ?: return@synchronized null
        val pendingCall = pending[requestId] ?: return@synchronized null
        val expectedAction = requestAction(requestCode)
        if (pendingCall.action != expectedAction) return@synchronized null
        activityRequestId = null
        val file = if (requestCode == CAMERA_REQUEST) cameraOutputFile.also { cameraOutputFile = null } else null
        val uri = if (requestCode == CAMERA_REQUEST) cameraOutputUri.also { cameraOutputUri = null } else null
        if (requestCode == FILE_REQUEST) pickerGrantOwnership.claim(resultUri)
        ActivityResultTarget(
            requestId,
            expectedAction,
            file,
            uri,
            resultUri,
            activityDeadlineMillis
                ?: NativeBridgePolicy.resolveActivityDeadline(0L, System.currentTimeMillis()),
        ).also { processingTarget = it }
    }

    private fun queueResultRead(target: ActivityResultTarget) {
        synchronized(requestLock) {
            if (processingTarget?.requestId != target.requestId) processingTarget = target
        }
        runCatching {
            ioExecutor.execute {
                try {
                    if (!mayProcessTarget(target)) return@execute
                    val body = when (target.action) {
                        "files.pick" -> fileJson(target.requestId, target.resultUri)
                        else -> cameraJson(target.requestId, target.cameraFile)
                    }
                    if (!mayProcessTarget(target)) return@execute
                    finishPending(target.requestId, successJson(target.requestId, body), target.cameraFile)
                } catch (_: PayloadTooLargeException) {
                    if (mayProcessTarget(target)) {
                        finishPending(
                            target.requestId,
                            errorJson("payload_too_large", "selected file is too large", target.requestId),
                            target.cameraFile,
                        )
                    }
                } catch (_: Exception) {
                    if (mayProcessTarget(target)) {
                        finishPending(
                            target.requestId,
                            errorJson("failed", "native operation failed", target.requestId),
                            target.cameraFile,
                        )
                    }
                } finally {
                    revokePickerGrant(takePickerGrant(target))
                }
            }
        }.onFailure {
            revokePickerGrant(takePickerGrant(target))
            if (mayProcessTarget(target)) {
                finishPending(
                    target.requestId,
                    errorJson("unavailable", "bridge is unavailable", target.requestId),
                    target.cameraFile,
                )
            }
        }
    }

    private fun mayProcessTarget(target: ActivityResultTarget): Boolean = synchronized(requestLock) {
        !preservingForConfiguration &&
            processingTarget?.requestId == target.requestId &&
            pending[target.requestId] != null
    } && !Thread.currentThread().isInterrupted

    /** Check both sides of blocking provider work without making timeout cleanup wait on that provider. */
    private fun <T> withActiveOperation(requestId: String, block: () -> T): T {
        ensureActiveOperation(requestId)
        val value = block()
        try {
            ensureActiveOperation(requestId)
            return value
        } catch (error: InterruptedException) {
            (value as? Closeable)?.runCatching { close() }
            throw error
        }
    }

    private fun ensureActiveOperation(requestId: String) = synchronized(requestLock) {
        if (preservingForConfiguration || pending[requestId] == null || Thread.currentThread().isInterrupted) {
            throw InterruptedException()
        }
    }

    private fun startFilePicker(input: JSONObject) {
        val mimeTypes = acceptedMimeTypes(input.opt("accept"))
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // The bridge imports one payload immediately and never requests persistable document access.
            addFlags(FILE_PICKER_GRANT_FLAGS)
            type = if (mimeTypes.size == 1) mimeTypes.single() else "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
        }
        activity.startActivityForResult(Intent.createChooser(intent, activity.getString(R.string.choose_file)), FILE_REQUEST)
    }

    private fun startCamera() {
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
            return
        }
        startCameraCapture()
    }

    private fun startCameraCapture() {
        val (output, outputUri) = synchronized(requestLock) {
            if (preservingForConfiguration) throw IllegalStateException("bridge handoff in progress")
            val cameraDirectory = File(activity.cacheDir, CAMERA_CACHE_DIRECTORY)
            if (!cameraDirectory.exists() && !cameraDirectory.mkdirs()) throw IllegalStateException("camera cache unavailable")
            val file = File.createTempFile("dsh-camera-", ".jpg", cameraDirectory)
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            cameraOutputFile = file
            cameraOutputUri = uri
            file to uri
        }
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, outputUri)
            clipData = ClipData.newRawUri("camera output", outputUri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(intent, activity.getString(R.string.take_photo)).apply {
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivityForResult(chooser, CAMERA_REQUEST)
    }

    /**
     * Fire-and-forget task notification. Unlike camera and picker flows this
     * needs no Activity result: the pending entry only survives a possible
     * runtime-permission round trip, then the reply closes immediately.
     */
    private fun startTaskNotification(requestId: String, input: JSONObject) {
        val title = NativeBridgePolicy.sanitizeNotificationField(
            input.optString("title", ""), NativeBridgePolicy.TASK_NOTIFICATION_TITLE_CHARS,
        )
        val body = NativeBridgePolicy.sanitizeNotificationField(
            input.optString("body", ""), NativeBridgePolicy.TASK_NOTIFICATION_BODY_CHARS,
        )
        val tag = NativeBridgePolicy.sanitizeNotificationTag(input.optString("tag", ""))
        if (title.isEmpty() && body.isEmpty()) {
            finishPending(requestId, errorJson("bad_message", "notification text is empty", requestId))
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            synchronized(requestLock) { pendingNotification = PendingNotification(requestId, title, body, tag) }
            activity.requestPermissions(
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                NOTIFICATION_PERMISSION_REQUEST,
            )
            return
        }
        activity.runOnUiThread {
            try {
                postTaskNotification(requestId, title, body, tag)
            } catch (_: Exception) {
                finishPending(requestId, errorJson("failed", "native operation failed", requestId))
            }
        }
    }

    private fun onNotificationPermissionResult(grantResults: IntArray): Boolean {
        if (preservingForConfiguration) return true
        val stashed = synchronized(requestLock) { pendingNotification?.also { pendingNotification = null } }
            ?: return true
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
            finishPending(stashed.requestId, errorJson("permission_denied", "notification permission was denied", stashed.requestId))
            return true
        }
        activity.runOnUiThread {
            try {
                postTaskNotification(stashed.requestId, stashed.title, stashed.body, stashed.tag)
            } catch (_: Exception) {
                finishPending(stashed.requestId, errorJson("failed", "native operation failed", stashed.requestId))
            }
        }
        return true
    }

    private fun postTaskNotification(requestId: String, title: String, body: String, tag: String) {
        val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: throw IllegalStateException("notification service is unavailable")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    NativeBridgePolicy.TASK_NOTIFICATION_CHANNEL_ID,
                    activity.getString(R.string.notification_channel_tasks),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = activity.getString(R.string.notification_channel_tasks_description) },
            )
        }
        val openApp = PendingIntent.getActivity(
            activity,
            NativeBridgePolicy.TASK_NOTIFICATION_ID,
            Intent(activity, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val shownTitle = title.ifEmpty { body }
        val shownBody = if (title.isEmpty() || body.isEmpty()) "" else body
        val notification = NotificationCompat.Builder(activity, NativeBridgePolicy.TASK_NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(shownTitle)
            .setContentText(if (shownBody.isEmpty()) null else shownBody)
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .build()
        manager.notify(tag, NativeBridgePolicy.TASK_NOTIFICATION_ID, notification)
        finishPending(requestId, successJson(requestId, JSONObject().put("ok", true)))
    }

    private fun revokeCameraGrant(uri: Uri?) {        if (uri == null) return
        runCatching {
            activity.revokeUriPermission(
                uri,
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
        }
    }

    private fun takePickerGrant(target: ActivityResultTarget): Uri? {
        val uri = target.resultUri ?: return null
        if (target.action != "files.pick") return null
        return synchronized(requestLock) { pickerGrantOwnership.release(uri) }
    }

    private fun revokePickerGrant(uri: Uri?) {
        if (uri == null) return
        runCatching { activity.revokeUriPermission(uri, FILE_PICKER_GRANT_FLAGS) }
    }

    private fun finishPending(requestId: String, body: String, cleanupCameraFile: File? = null) {
        val boundedBody = if (NativeBridgePolicy.isMessageWithinLimit(body, NativeBridgePolicy.MAX_REPLY_BYTES)) {
            body
        } else {
            errorJson("payload_too_large", "native reply is too large", requestId)
        }
        val (call, deleteNow) = synchronized(requestLock) {
            val claimed = pending.remove(requestId) ?: return
            if (activityRequestId == requestId) activityRequestId = null
            processingTarget?.takeIf { it.requestId == requestId }?.let { processingTarget = null }
            if (activityDeadlineRequestId == requestId) {
                cancelActivityTimeoutLocked()
                activityDeadlineRequestId = null
                activityDeadlineMillis = null
            }
            claimed to cameraCleanupOwnership.onTerminal(cleanupCameraFile)
        }
        webView.post { runCatching { call.replyProxy.postMessage(boundedBody) } }
        deleteNow?.delete()
    }

    private fun postDirectReply(replyProxy: JavaScriptReplyProxy?, body: String) {
        if (replyProxy == null) return
        val bounded = if (NativeBridgePolicy.isMessageWithinLimit(body, NativeBridgePolicy.MAX_REPLY_BYTES)) body
        else errorJson("payload_too_large", "native reply is too large", "")
        webView.post { runCatching { replyProxy.postMessage(bounded) } }
    }

    private fun requestAction(requestCode: Int): String = when (requestCode) {
        FILE_REQUEST -> "files.pick"
        else -> "camera.capture"
    }

    private fun fileJson(requestId: String, uri: Uri?): JSONObject {
        if (uri == null) throw Exception("no file selected")
        val resolver = activity.contentResolver
        var displayName: String? = null
        var declaredSize: Long? = null
        withActiveOperation(requestId) {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { displayName = cursor.getString(it) }
                    cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { declaredSize = cursor.getLong(it) }
                }
            }
        }
        if (declaredSize != null && declaredSize!! > NativeBridgePolicy.MAX_BINARY_BYTES) throw PayloadTooLargeException()
        val input = withActiveOperation(requestId) { resolver.openInputStream(uri) }
            ?: throw Exception("selected file is unavailable")
        val bytes = input.use { readBounded(requestId, it, declaredSize) }
        val type = withActiveOperation(requestId) { resolver.getType(uri) }
            ?.takeIf { MIME_TYPE.matches(it.lowercase()) }
            ?: "application/octet-stream"
        val name = safeDisplayName(displayName ?: uri.lastPathSegment ?: "file")
        return binaryJson(requestId, name, type, bytes)
    }

    private fun cameraJson(requestId: String, file: File?): JSONObject {
        if (file == null || !file.isFile || file.length() <= 0L) throw Exception("camera result unavailable")
        if (file.length() > NativeBridgePolicy.MAX_BINARY_BYTES) throw PayloadTooLargeException()
        val bytes = file.inputStream().use { readBounded(requestId, it, file.length()) }
        return binaryJson(requestId, "camera-${System.currentTimeMillis()}.jpg", "image/jpeg", bytes)
    }

    private fun readBounded(
        requestId: String,
        input: InputStream,
        declaredSize: Long?,
        maxBytes: Int = NativeBridgePolicy.MAX_BINARY_BYTES,
    ): ByteArray {
        val capacity = declaredSize
            ?.takeIf { it in 1..maxBytes.toLong() }
            ?.toInt()
            ?: DEFAULT_BUFFER_SIZE
        val output = OwnedByteArrayOutputStream(capacity)
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val count = withActiveOperation(requestId) { input.read(buffer) }
            if (count < 0) break
            total += count
            if (total > maxBytes) throw PayloadTooLargeException()
            output.write(buffer, 0, count)
        }
        // Provider and camera sizes are normally exact, so return the owned buffer
        // instead of duplicating an up-to-8 MiB payload before Base64 encoding.
        return output.takeBytes()
    }

    private fun binaryJson(requestId: String, name: String, type: String, bytes: ByteArray): JSONObject {
        val encoded = withActiveOperation(requestId) { Base64.getEncoder().encodeToString(bytes) }
        return JSONObject().apply {
            put("name", name)
            put("type", type)
            put("base64", encoded)
        }
    }

    private fun acceptedMimeTypes(rawAccept: Any?): List<String> {
        val values = when (rawAccept) {
            is JSONArray -> (0 until rawAccept.length()).mapNotNull { rawAccept.optString(it, null) }
            is String -> listOf(rawAccept)
            else -> emptyList()
        }
        return values
            .flatMap { it.split(',') }
            .map { it.trim().lowercase() }
            .filter { MIME_TYPE.matches(it) }
            .distinct()
            .ifEmpty { listOf("*/*") }
    }

    private fun safeDisplayName(rawName: String): String {
        val sanitized = rawName.replace(UNSAFE_FILENAME, "_").trim().take(255)
        return sanitized.ifBlank { "file" }
    }

    private fun restoreState(state: Bundle?) {
        if (state == null) return
        val requestId = state.getString(STATE_REQUEST_ID).orEmpty()
        val action = state.getString(STATE_ACTION).orEmpty()
        if (requestId.isBlank() || requestId.length > MAX_REQUEST_ID_CHARS || action !in ACTIVITY_ACTIONS) return
        restoredOperation = RestoredOperation(
            requestId = requestId,
            action = action,
            processing = state.getBoolean(STATE_PROCESSING),
            cameraFile = validatedCameraFile(state.getString(STATE_CAMERA_FILE)),
            cameraUri = state.getString(STATE_CAMERA_URI)?.let { runCatching { Uri.parse(it) }.getOrNull() },
            deadlineMillis = NativeBridgePolicy.resolveActivityDeadline(
                state.getLong(STATE_DEADLINE_MILLIS, 0L),
                System.currentTimeMillis(),
            ),
        )
    }

    private fun operationStateBundle(
        requestId: String,
        action: String,
        processing: Boolean,
        cameraFile: File?,
        cameraUri: Uri?,
        deadlineMillis: Long,
    ): Bundle = Bundle().apply {
        putString(STATE_REQUEST_ID, requestId)
        putString(STATE_ACTION, action)
        putBoolean(STATE_PROCESSING, processing)
        putString(STATE_CAMERA_FILE, cameraFile?.absolutePath)
        putString(STATE_CAMERA_URI, cameraUri?.toString())
        putLong(STATE_DEADLINE_MILLIS, deadlineMillis)
    }

    private fun takeRestoredOperation(requestCode: Int): RestoredOperation? = synchronized(requestLock) {
        val restored = restoredOperation ?: return@synchronized null
        if (restored.processing || restored.action != requestAction(requestCode)) return@synchronized null
        restoredOperation = null
        if (activityDeadlineRequestId == restored.requestId) {
            cancelActivityTimeoutLocked()
            activityDeadlineRequestId = null
            activityDeadlineMillis = null
        }
        restored
    }

    private fun cleanupRestoredOperation(restored: RestoredOperation) {
        val plan = restoredNoCallerCleanupPlan(
            hasCameraFile = restored.cameraFile != null,
            hasCameraGrant = restored.cameraUri != null,
        )
        check(!restored.disposition.requiresPayloadRead() && !plan.readPayload)
        synchronized(requestLock) {
            if (restoredOperation?.requestId == restored.requestId) restoredOperation = null
            if (activityDeadlineRequestId == restored.requestId) {
                cancelActivityTimeoutLocked()
                activityDeadlineRequestId = null
                activityDeadlineMillis = null
            }
        }
        if (plan.revokeGrant) revokeCameraGrant(restored.cameraUri)
        if (plan.deleteCameraFile) restored.cameraFile?.delete()
    }

    private fun validatedCameraFile(rawPath: String?): File? {
        if (rawPath.isNullOrBlank()) return null
        return runCatching {
            val directory = File(activity.cacheDir, CAMERA_CACHE_DIRECTORY).canonicalFile
            val candidate = File(rawPath).canonicalFile
            candidate.takeIf { it.parentFile == directory && it.name.startsWith("dsh-camera-") }
        }.getOrNull()
    }

    private fun pageAdapterScript(): String = """
        (() => {
          const bridge = window.$JS_OBJECT_NAME;
          if (!bridge || typeof bridge.postMessage !== 'function') return;
          const oldState = window.__DSH_MOBILE_NATIVE_STATE__;
          const pending = oldState && oldState.pending instanceof Map ? oldState.pending : new Map();
          const materialize = value => { if (!value || typeof value !== 'object' || typeof value.base64 !== 'string' || typeof value.name !== 'string') return value; try { const raw = atob(value.base64); const bytes = Uint8Array.from(raw, char => char.charCodeAt(0)); return new File([bytes], value.name, { type: value.type || 'application/octet-stream' }); } catch (_) { return value; } };
          const handleReply = event => {
            try {
              const response = JSON.parse(typeof event === 'string' ? event : event.data);
              const item = pending.get(response.requestId);
              if (!item) return;
              clearTimeout(item.timer);
              pending.delete(response.requestId);
              if (response.ok) item.resolve(materialize(response.value));
              else item.reject(Object.assign(new Error(response.message || response.code), { code: response.code }));
            } catch (_) {}
          };
          bridge.onmessage = handleReply;
          window.__DSH_MOBILE_NATIVE_STATE__ = { pending };
          window.__DSH_MOBILE_NATIVE__ = {
            capabilities: () => Promise.resolve(['files.pick','camera.capture','share','clipboard.read','clipboard.write','notification.notify']),
            invoke: (action, input = {}) => new Promise((resolve, reject) => {
              const requestId = crypto.randomUUID();
              let raw;
              try { raw = JSON.stringify({ version: 1, requestId, action, input }); }
              catch (_) { reject(Object.assign(new Error('native message is invalid'), { code: 'bad_message' })); return; }
              if (new TextEncoder().encode(raw).byteLength > $MAX_MESSAGE_BYTES) { reject(Object.assign(new Error('native message is too large'), { code: 'bad_message' })); return; }
              const waitsForActivity = action === 'files.pick' || action === 'camera.capture';
              const timeout = waitsForActivity ? ${NativeBridgePolicy.PAGE_ACTIVITY_TIMEOUT_MS} : 60000;
              const timer = setTimeout(() => { const item = pending.get(requestId); if (item) { pending.delete(requestId); item.reject(Object.assign(new Error('native capability timed out'), { code: 'timeout' })); } }, timeout);
              pending.set(requestId, { resolve, reject, timer });
              try { bridge.postMessage(raw); }
              catch (_) { clearTimeout(timer); pending.delete(requestId); reject(Object.assign(new Error('native capability unavailable'), { code: 'unavailable' })); }
            })
          };

          const previousChromeSync = window.__DSH_MOBILE_CHROME_SYNC__;
          if (previousChromeSync && typeof previousChromeSync.dispose === 'function') previousChromeSync.dispose();
          let chromeFrame = 0;
          let lastChromeColor = '';
          const postEvent = message => { try { bridge.postMessage(JSON.stringify(Object.assign({ version: 1 }, message))); } catch (_) {} };
          const parseChromeColor = value => {
            if (!value || !document.documentElement) return null;
            const probe = document.createElement('span');
            probe.style.position = 'fixed'; probe.style.visibility = 'hidden'; probe.style.pointerEvents = 'none'; probe.style.color = value.trim();
            document.documentElement.appendChild(probe);
            const resolved = getComputedStyle(probe).color; probe.remove();
            const match = resolved.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)(?:\D+(\d+(?:\.\d+)?))?\s*\)$/i);
            if (!match || (match[4] !== undefined && Number(match[4]) === 0)) return null;
            return [Number(match[1]), Number(match[2]), Number(match[3])].map(channel => Math.max(0, Math.min(255, Math.round(channel))));
          };
          const resolveChromeColor = () => {
            const rootStyle = getComputedStyle(document.documentElement);
            const candidates = [rootStyle.getPropertyValue('--dsw-alias-bg-base'), document.body ? getComputedStyle(document.body).backgroundColor : '', rootStyle.backgroundColor, 'rgb(255, 255, 255)'];
            for (const candidate of candidates) { const color = parseChromeColor(candidate); if (color) return color; }
            return [255, 255, 255];
          };
          const syncChromeColor = () => {
            chromeFrame = 0; const color = resolveChromeColor(); const key = color.join(',');
            if (key === lastChromeColor) return; lastChromeColor = key;
            postEvent({ event: 'page.background', red: color[0], green: color[1], blue: color[2] });
          };
          const scheduleChromeSync = () => { if (!chromeFrame) chromeFrame = requestAnimationFrame(syncChromeColor); };
          const chromeObserver = new MutationObserver(scheduleChromeSync);
          chromeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
          if (document.body) chromeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
          const colorScheme = matchMedia('(prefers-color-scheme: dark)');
          if (typeof colorScheme.addEventListener === 'function') colorScheme.addEventListener('change', scheduleChromeSync); else if (typeof colorScheme.addListener === 'function') colorScheme.addListener(scheduleChromeSync);

          const previousScrollSync = window.__DSH_MOBILE_SCROLL_SYNC__;
          if (previousScrollSync && typeof previousScrollSync.dispose === 'function') previousScrollSync.dispose();
          let lastScrollY = Math.max(0, (document.scrollingElement || document.documentElement).scrollTop || 0);
          let lastScrollAt = 0;
          const onPageScroll = () => {
            const now = Date.now(); if (now - lastScrollAt < 120) return; lastScrollAt = now;
            const scroller = document.scrollingElement || document.documentElement; const y = Math.max(0, scroller.scrollTop || 0); const delta = y - lastScrollY; lastScrollY = y;
            if (delta > 4) postEvent({ event: 'page.scroll', direction: 'down' }); else if (delta < -4) postEvent({ event: 'page.scroll', direction: 'up' });
          };
          document.addEventListener('scroll', onPageScroll, { passive: true, capture: true });
          window.__DSH_MOBILE_SCROLL_SYNC__ = { dispose: () => document.removeEventListener('scroll', onPageScroll, { capture: true }) };
          window.__DSH_MOBILE_CHROME_SYNC__ = { dispose: () => { chromeObserver.disconnect(); if (chromeFrame) cancelAnimationFrame(chromeFrame); if (typeof colorScheme.removeEventListener === 'function') colorScheme.removeEventListener('change', scheduleChromeSync); else if (typeof colorScheme.removeListener === 'function') colorScheme.removeListener(scheduleChromeSync); } };
          scheduleChromeSync();
        })();
    """.trimIndent().replace("$JS_OBJECT_NAME", JS_OBJECT_NAME)

    private fun successJson(requestId: String, value: JSONObject): String =
        JSONObject().apply { put("requestId", requestId); put("ok", true); put("value", value) }.toString()

    private fun errorJson(code: String, message: String, requestId: String): String =
        JSONObject().apply { put("requestId", requestId); put("ok", false); put("code", code); put("message", message) }.toString()

    companion object {
        private const val JS_OBJECT_NAME = "dshMobileNative"
        const val MAX_PENDING = 16
        const val MAX_MESSAGE_BYTES = NativeBridgePolicy.MAX_MESSAGE_BYTES
        private const val MAX_REQUEST_ID_CHARS = 128
        private const val FILE_REQUEST = 5101
        private const val CAMERA_REQUEST = 5102
        const val CAMERA_PERMISSION_REQUEST = 5103
        const val NOTIFICATION_PERMISSION_REQUEST = 5104
        private const val FILE_PICKER_GRANT_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION
        private const val CAMERA_CACHE_DIRECTORY = "native-camera"
        private const val STATE_REQUEST_ID = "requestId"
        private const val STATE_ACTION = "action"
        private const val STATE_PROCESSING = "processing"
        private const val STATE_CAMERA_FILE = "cameraFile"
        private const val STATE_CAMERA_URI = "cameraUri"
        private const val STATE_DEADLINE_MILLIS = "deadlineMillis"
        private const val RESTORED_CLEANUP_REQUEST_ID = "restored-camera-cleanup"
        private val ACTIVITY_ACTIONS = setOf("files.pick", "camera.capture")
        private val MIME_TYPE = Regex("^[a-z0-9!#${'$'}&^_.+-]+/[a-z0-9!#${'$'}&^_.+*-]+${'$'}")
        private val UNSAFE_FILENAME = Regex("[\\\\/\\p{Cc}]")

        fun isBridgeRequestCode(requestCode: Int): Boolean = requestCode == FILE_REQUEST || requestCode == CAMERA_REQUEST

        fun disposeSavedState(activity: Activity, state: Bundle) {
            state.getString(STATE_CAMERA_URI)?.let { rawUri ->
                runCatching {
                    activity.revokeUriPermission(
                        Uri.parse(rawUri),
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION,
                    )
                }
            }
            state.getString(STATE_CAMERA_FILE)?.let { rawPath ->
                runCatching {
                    val directory = File(activity.cacheDir, CAMERA_CACHE_DIRECTORY).canonicalFile
                    val candidate = File(rawPath).canonicalFile
                    if (candidate.parentFile == directory && candidate.name.startsWith("dsh-camera-")) candidate.delete()
                }
            }
        }
    }
}
