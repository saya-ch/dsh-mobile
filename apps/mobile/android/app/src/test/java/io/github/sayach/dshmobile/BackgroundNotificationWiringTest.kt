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
