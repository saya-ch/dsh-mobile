package io.github.sayach.dshmobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/** One native task-notification implementation shared by the WebView bridge and background service. */
internal object TaskNotificationPublisher {
    fun post(context: Context, title: String, body: String, tag: String, navigate: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: throw IllegalStateException("notification service is unavailable")
        ensureChannel(context, manager)
        val openApp = PendingIntent.getActivity(
            context,
            NativeBridgePolicy.notificationRequestCode(tag),
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                if (navigate.isNotEmpty()) putExtra(NativeBridgePolicy.EXTRA_NOTIFICATION_NAVIGATE, navigate)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val shownTitle = title.ifEmpty { body }
        val shownBody = if (title.isEmpty() || body.isEmpty()) "" else body
        val notification = NotificationCompat.Builder(context, NativeBridgePolicy.TASK_NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_task_notification)
            .setContentTitle(shownTitle)
            .setContentText(if (shownBody.isEmpty()) null else shownBody)
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        manager.notify(tag, NativeBridgePolicy.TASK_NOTIFICATION_ID, notification)
    }

    fun ensureChannel(context: Context, manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        manager.createNotificationChannel(
            NotificationChannel(
                NativeBridgePolicy.TASK_NOTIFICATION_CHANNEL_ID,
                context.getString(R.string.notification_channel_tasks),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = context.getString(R.string.notification_channel_tasks_description) },
        )
    }
}
