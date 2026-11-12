package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundNotificationWiringTest {
    private fun source(path: String): String = File("src/main/$path").readText()

    @Test
    fun manifestAndBridgeExposeAnOptInNonExportedService() {
        val manifest = source("AndroidManifest.xml")
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE"))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        // Match the service element itself: other components in this manifest also declare exported="false".
        val serviceElement = manifest.substringAfter("<service").substringBefore(">")
        assertTrue(serviceElement.contains("android:name=\".BackgroundNotificationService\""))
        assertTrue(serviceElement.contains("android:exported=\"false\""))
        assertTrue(serviceElement.contains("android:foregroundServiceType=\"dataSync\""))

        val bridge = source("java/io/github/sayach/dshmobile/NativeBridge.kt")
        assertTrue(bridge.contains("notification.background.get"))
        assertTrue(bridge.contains("notification.background.set"))
        assertFalse(bridge.contains(".addJavascriptInterface("))
    }

    @Test
    fun serviceUsesPairedCredentialsAndTheDedicatedBackgroundRoute() {
        val service = source("java/io/github/sayach/dshmobile/BackgroundNotificationService.kt")
        val activity = source("java/io/github/sayach/dshmobile/MainActivity.kt")
        assertTrue(service.contains("NativeAuthClient.renew"))
        assertTrue(service.contains("PinnedTls.socketFactory"))
        assertTrue(service.contains("\"/mobile-access/background-events\""))
        assertTrue(service.contains("__Host-dsh_ma_session"))
        assertTrue(service.contains("TaskNotificationPublisher.post"))
        assertTrue(service.contains("START_STICKY"))
        assertTrue(activity.contains("bridge.onSetBackgroundNotifications = ::setBackgroundNotifications"))
        assertTrue(activity.contains("BackgroundNotificationService.resumeIfEnabled(this, record.key)"))
        assertTrue(activity.contains("BackgroundNotificationService.disable(this)"))
    }

    @Test
    fun backgroundStatusAndFailureReasonsAreExposedWithoutSecrets() {
        val service = source("java/io/github/sayach/dshmobile/BackgroundNotificationService.kt")
        val notification = source("java/io/github/sayach/dshmobile/BackgroundTaskNotification.kt")
        val bridge = source("java/io/github/sayach/dshmobile/NativeBridge.kt")
        val activity = source("java/io/github/sayach/dshmobile/MainActivity.kt")
        assertTrue(service.contains("fun status(context: Context): JSONObject"))
        assertTrue(service.contains("\"connected\""))
        assertTrue(service.contains("\"lastEventAt\""))
        assertTrue(service.contains("\"lastError\""))
        // The page-side completion tag keeps `dsh-task-done-…`; the background key must not collide
        // and must stay the single record key for one Session+turn (issue #400).
        assertTrue(notification.contains("dsh-task-bg-"))
        assertTrue(service.contains("BackgroundTaskNotification.tag(sessionId, turn)"))
        assertTrue(service.contains("BackgroundTaskNotification.pageOwnsDelivery"))
        assertTrue(service.contains("BackgroundTaskNotification.eventText(event, \"title\")"))
        assertTrue(service.contains("BackgroundTaskNotification.eventText(event, \"body\")"))
        assertTrue(activity.contains("AppProcessForeground.entered()"))
        assertTrue(activity.contains("AppProcessForeground.exited()"))
        assertTrue(service.contains("Log.w(LOG_TAG"))
        assertTrue(bridge.contains("var onGetBackgroundNotificationStatus"))
        assertTrue(bridge.contains("status?.invoke()"))
        assertTrue(activity.contains("BackgroundNotificationService.status(this)"))
        assertTrue(activity.contains("resumeIfEnabled"))
    }

    @Test
    fun warmNotificationTapUsesTheLivePageBeforeReloading() {
        val activity = source("java/io/github/sayach/dshmobile/MainActivity.kt")
        assertTrue(activity.contains("window.__dshMobileOpenSession"))
        assertTrue(activity.contains("evaluateJavascript(script)"))
        assertTrue(activity.contains("if (!handled) browser.loadUrl(full)"))
        // The cold-start path still owns its pending route through showBrowser().
        assertTrue(activity.contains("pendingNotificationNavigate"))
    }

    @Test
    fun serviceWithdrawsItsClaimOnAPlatformTimeoutAndNotificationsIdentifyTheirTag() {
        val service = source("java/io/github/sayach/dshmobile/BackgroundNotificationService.kt")
        // Android 14 delivers the bounded type through onTimeout(startId); Android 15+ for dataSync
        // through onTimeout(startId, fgsType). Both must stop the service and drop the opt-in.
        assertTrue(service.contains("override fun onTimeout(startId: Int)"))
        assertTrue(service.contains("override fun onTimeout(startId: Int, fgsType: Int)"))
        assertTrue(service.contains("stopForeground(STOP_FOREGROUND_REMOVE)"))
        assertTrue(service.contains("setEnabled(this, false)"))
        // A rejected platform start must roll the persisted claim back instead of reporting enabled.
        assertTrue(service.contains("clearEnabled(context)"))

        val publisher = source("java/io/github/sayach/dshmobile/TaskNotificationPublisher.kt")
        assertTrue(publisher.contains("data = Uri.parse(NativeBridgePolicy.notificationIntentData(tag))"))
    }
}
