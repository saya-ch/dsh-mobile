package io.github.sayach.dshmobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Opt-in foreground delivery for Host task events when the WebView page is
 * suspended. It uses the paired device credential through the native renewal
 * endpoint and the gateway's background-only SSE route.
 */
internal class BackgroundNotificationService : Service() {
    private val running = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var connection: HttpURLConnection? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || !isEnabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val key = intent?.getStringExtra(EXTRA_DEVICE_KEY)
            ?: preferences().getString(KEY_DEVICE, null)
        if (key.isNullOrEmpty()) {
            setEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        preferences().edit().putString(KEY_DEVICE, key).apply()
        startForeground(FOREGROUND_ID, foregroundNotification())
        if (!running.getAndSet(true)) worker.execute { runLoop() }
        else connection?.disconnect()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running.set(false)
        connection?.disconnect()
        connection = null
        worker.shutdownNow()
        super.onDestroy()
    }

    /**
     * Bounded foreground service types reach this callback once their platform time budget is
     * spent: Android 14 (API 34) for `shortService`, Android 15+ (API 35) for `dataSync`.
     *
     * The callbacks are overridden rather than delegated because the platform default raises an
     * exception for a timed-out service. Declaring them is safe below their API level: an override
     * that the runtime superclass does not know is simply never invoked.
     */
    override fun onTimeout(startId: Int) {
        handleForegroundTimeout()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        handleForegroundTimeout()
    }

    /**
     * Stop the timed-out stream the same way a revoked device does, and withdraw the persisted
     * opt-in so `notification.background.get` cannot keep claiming an enabled service.
     */
    private fun handleForegroundTimeout() {
        running.set(false)
        connection?.disconnect()
        connection = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        setEnabled(this, false)
        stopSelf()
    }

    private fun runLoop() {
        var failedAttempts = 0
        while (running.get()) {
            try {
                val record = readDevice()
                if (record == null) {
                    setEnabled(this, false)
                    break
                }
                if (record.iroh != null) throw IOException("iroh background notifications are not supported")
                val session = NativeAuthClient.renew(
                    record.origin,
                    record.deviceToken,
                    record.caCertificate,
                    record.instanceId,
                )
                connection = openEventStream(record, session)
                failedAttempts = 0
                readEvents(connection!!)
            } catch (failure: NativeAuthFailure) {
                if (failure.kind == NativeAuthFailureKind.DEVICE_REVOKED
                    || failure.kind == NativeAuthFailureKind.DEVICE_EXPIRED
                    || failure.kind == NativeAuthFailureKind.PAIRING_EXPIRED
                ) {
                    setEnabled(this, false)
                    break
                }
                failedAttempts = (failedAttempts + 1).coerceAtMost(6)
            } catch (_: Exception) {
                failedAttempts = (failedAttempts + 1).coerceAtMost(6)
            } finally {
                connection?.disconnect()
                connection = null
            }
            if (!running.get()) break
            try {
                Thread.sleep(minOf(30_000L, 1_000L shl failedAttempts))
            } catch (_: InterruptedException) {
                // Teardown interrupts this backoff; leaving the exception uncaught would reach the
                // process-wide handler and kill the app from a worker thread.
                break
            }
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun readDevice(): PairedDeviceRecord? {
        val key = preferences().getString(KEY_DEVICE, null) ?: return null
        return PairedDeviceStore(applicationContext).load().firstOrNull { it.key == key }
    }

    private fun preferences() = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private fun openEventStream(record: PairedDeviceRecord, session: NativeSession): HttpURLConnection {
        val connection = LocalTransport.open(record.origin, BACKGROUND_EVENT_PATH)
        record.caCertificate?.let { connection.sslSocketFactory = PinnedTls.socketFactory(it) }
        connection.requestMethod = "GET"
        connection.connectTimeout = 15_000
        connection.readTimeout = 45_000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "text/event-stream")
        connection.setRequestProperty("Cache-Control", "no-cache")
        connection.setRequestProperty("Origin", record.origin.serialized)
        connection.setRequestProperty("Sec-Fetch-Site", "same-origin")
        connection.setRequestProperty(
            "Cookie",
            "dsh_ma_session=${session.sessionToken}; " +
                "__Host-dsh_ma_session=${session.sessionToken}",
        )
        connection.connect()
        if (connection.responseCode != HttpURLConnection.HTTP_OK) {
            throw IOException("background event stream rejected")
        }
        if (!connection.contentType.orEmpty().substringBefore(';').trim()
                .equals("text/event-stream", ignoreCase = true)) {
            throw IOException("background event stream returned the wrong content type")
        }
        return connection
    }

    private fun readEvents(connection: HttpURLConnection) {
        connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
            var event = ""
            val data = StringBuilder()
            while (running.get()) {
                val line = reader.readLine() ?: return
                when {
                    line.isBlank() -> {
                        if (event == "task-notify" && data.isNotEmpty()) notifyTask(data.toString())
                        if (event == "device-revoked" && data.isNotEmpty()) {
                            setEnabled(this, false)
                            throw IOException("device revoked")
                        }
                        event = ""
                        data.clear()
                    }
                    line.startsWith("event:") -> event = line.substringAfter(':').trim()
                    line.startsWith("data:") -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(line.substringAfter(':').removePrefix(" "))
                    }
                }
            }
        }
    }

    private fun notifyTask(payload: String) {
        val event = JSONObject(payload)
        val sessionId = event.optString("sessionId", "").trim()
        if (sessionId.isEmpty()) return
        val turn = event.optInt("turn", 0).coerceAtLeast(0)
        val navigate = sessionRoute(sessionId)
        TaskNotificationPublisher.post(
            this,
            getString(R.string.background_notifications_done_title),
            getString(R.string.background_notifications_done_body),
            completionTag(sessionId, turn),
            navigate,
        )
    }

    private fun foregroundNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_task_notification)
        .setContentTitle(getString(R.string.background_notifications_running))
        .setContentText(getString(R.string.background_notifications_running_text))
        .setContentIntent(PendingIntent.getActivity(
            this,
            FOREGROUND_ID,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setVisibility(NotificationCompat.VISIBILITY_SECRET)
        .build()

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_background),
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = getString(R.string.notification_channel_background_description) },
        )
        TaskNotificationPublisher.ensureChannel(this, manager)
    }

    companion object {
        private const val ACTION_START = "io.github.sayach.dshmobile.BACKGROUND_NOTIFY_START"
        private const val ACTION_STOP = "io.github.sayach.dshmobile.BACKGROUND_NOTIFY_STOP"
        private const val EXTRA_DEVICE_KEY = "deviceKey"
        private const val CHANNEL_ID = "dsh-mobile-background"
        private const val FOREGROUND_ID = 7100
        private const val PREFERENCES = "dsh_mobile_background_notifications"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_DEVICE = "device"
        private const val BACKGROUND_EVENT_PATH = "/mobile-access/background-events"

        fun isEnabled(context: Context): Boolean = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(KEY_ENABLED, false)

        /**
         * Opt in and start the foreground stream. The persisted claim is written before the start
         * because [onStartCommand] refuses to run without it, and is rolled back when the platform
         * rejects the start; otherwise a rejected start keeps `isEnabled` claiming a service that
         * is not running.
         */
        fun enable(context: Context, deviceKey: String): Boolean {
            if (deviceKey.isEmpty()) return false
            val device = runCatching {
                PairedDeviceStore(context.applicationContext).load().firstOrNull { it.key == deviceKey }
            }.getOrNull() ?: return false
            if (device.iroh != null) return false
            val persisted = runCatching {
                context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                    .putBoolean(KEY_ENABLED, true)
                    .putString(KEY_DEVICE, deviceKey)
                    .commit()
            }.getOrDefault(false)
            if (!persisted) {
                clearEnabled(context)
                return false
            }
            val intent = Intent(context, BackgroundNotificationService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_DEVICE_KEY, deviceKey)
            // A rejected start (a background-start restriction, for example) must not survive as a claim.
            val started = runCatching { context.startForegroundService(intent) }.getOrNull() != null
            if (!started) {
                clearEnabled(context)
                return false
            }
            return true
        }

        fun disable(context: Context) {
            setEnabled(context, false)
            context.stopService(Intent(context, BackgroundNotificationService::class.java))
        }

        fun resumeIfEnabled(context: Context, deviceKey: String) {
            val prefs = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            if (!prefs.getBoolean(KEY_ENABLED, false) || prefs.getString(KEY_DEVICE, null) != deviceKey) return
            if (!enable(context, deviceKey)) clearEnabled(context)
        }

        private fun setEnabled(context: Context, enabled: Boolean) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_ENABLED, enabled)
                .apply()
        }

        /** Withdraw the opt-in flag and its device binding so no reader can report an enabled service. */
        private fun clearEnabled(context: Context) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_ENABLED, false)
                .remove(KEY_DEVICE)
                .apply()
        }

        private fun completionTag(sessionId: String, turn: Int): String {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(JSONObject.quote(sessionId).toByteArray(Charsets.UTF_8))
                .take(16)
                .joinToString("") { "%02x".format(it) }
            return "dsh-task-done-$digest-${turn.coerceAtLeast(0)}"
        }

        private fun sessionRoute(sessionId: String): String {
            val encoded = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(sessionId.toByteArray(Charsets.UTF_8))
            val route = "/?dsh-session=$encoded"
            return if (route.length <= NativeBridgePolicy.NOTIFICATION_NAVIGATE_CHARS) route else ""
        }
    }
}
