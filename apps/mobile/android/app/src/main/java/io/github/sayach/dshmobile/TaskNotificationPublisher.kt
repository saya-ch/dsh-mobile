package io.github.sayach.dshmobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** One native task-notification implementation shared by the WebView bridge and background service. */
internal object TaskNotificationPublisher {
    /**
     * Whether a completion record can actually appear: the app may post notifications and the
     * task-notification channel, when it already exists, is not blocked at [NotificationManager.IMPORTANCE_NONE].
     *
     * `post` creates a missing channel, so "no channel yet" is not treated as blocked; a revoked
     * Android 13+ permission or a channel the user switched off makes `notify` a silent no-op, which
     * is exactly the state the page must not mistake for a delivered reminder.
     */
    fun canPost(context: Context): Boolean {
        val notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        val channelBlocked = if (manager !== null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.getNotificationChannel(NativeBridgePolicy.TASK_NOTIFICATION_CHANNEL_ID)?.importance ==
                NotificationManager.IMPORTANCE_NONE
        } else {
            false
        }
        return BackgroundTaskNotification.canPost(notificationsEnabled, channelBlocked)
    }

    fun post(context: Context, title: String, body: String, tag: String, navigate: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: throw IllegalStateException("notification service is unavailable")
        ensureChannel(context, manager)
        val openApp = PendingIntent.getActivity(
            context,
            NativeBridgePolicy.notificationRequestCode(tag),
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                // PendingIntent identity ignores extras, so two tags whose request codes collide would
                // overwrite each other's navigation target. The tag in the data URI keeps them apart;
                // the Activity reads only its extras, so navigation itself is unchanged.
                data = Uri.parse(NativeBridgePolicy.notificationIntentData(tag))
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
