package io.github.sayach.dshmobile

import org.json.JSONObject
import java.security.MessageDigest

/**
 * Decisions for the background completion notification (issue #400): which text the record shows,
 * which notification key it uses, and when the service must leave delivery to the live page.
 *
 * The Android pieces (`NotificationManager`, the service) stay in
 * [BackgroundNotificationService] and [TaskNotificationPublisher]; everything here is pure Kotlin so
 * the JVM unit suite can assert it without a device or a running Service.
 */
internal object BackgroundTaskNotification {
    /**
     * The background stream keeps its own prefix so the origin of a record stays identifiable; the
     * page path posts `dsh-task-done-…` and must never collide with this one.
     */
    const val TAG_PREFIX = "dsh-task-bg-"

    /**
     * Notification key for one finished turn: `dsh-task-bg-<32 hex digest>-<turn>`.
     *
     * Android keys a notification record by (tag, id) and [TaskNotificationPublisher] always posts
     * with [NativeBridgePolicy.TASK_NOTIFICATION_ID], so two events for the same Session and turn
     * write the same record (a replacement), while another turn stays a separate record. The digest
     * is the same SHA-256-of-the-quoted-Session-id form the 0.7.4 service used, so an upgrade does
     * not change the key of a record already dismissed or still shown.
     */
    fun tag(sessionId: String, turn: Int): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(JSONObject.quote(sessionId).toByteArray(Charsets.UTF_8))
            .take(16)
            .joinToString("") { "%02x".format(it) }
        return TAG_PREFIX + digest + "-" + turn.coerceAtLeast(0)
    }

    /**
     * Lock-screen title: the plugin's bounded Session display name when it is usable, otherwise the
     * localized fallback.
     *
     * [NativeBridgePolicy.sanitizeNotificationField] trims, collapses newlines, drops control
     * characters and bounds the length, so a noisy or hostile payload cannot widen the record; a
     * blank result is treated as absent and falls back.
     */
    fun title(eventTitle: String?, fallback: String): String = bounded(
        eventTitle,
        NativeBridgePolicy.TASK_NOTIFICATION_TITLE_CHARS,
    ).ifEmpty { fallback }

    /** Lock-screen body: the plugin's bounded first line of the turn, otherwise the fallback. */
    fun body(eventBody: String?, fallback: String): String = bounded(
        eventBody,
        NativeBridgePolicy.TASK_NOTIFICATION_BODY_CHARS,
    ).ifEmpty { fallback }

    private fun bounded(value: String?, maxChars: Int): String =
        if (value == null) "" else NativeBridgePolicy.sanitizeNotificationField(value, maxChars)

    /**
     * Reads an optional plugin string from the announced event. A JSON `null`, a missing key and any
     * non-string value are all absent, so an older plugin keeps the localized fallback and a numeric
     * or object payload is never rendered as the Session name (or as the literal text `null`).
     */
    fun eventText(event: JSONObject, key: String): String? =
        if (event.isNull(key)) null else (event.opt(key) as? String)?.takeIf { it.isNotEmpty() }

    /**
     * Whether a completion record would actually become visible.
     *
     * A connected stream is not permission to post: on Android 13+ the notification permission can
     * be revoked, and an existing task-notification channel can be blocked at `IMPORTANCE_NONE`.
     * `NotificationManager.notify` silently does nothing in both cases, so the page must not yield
     * delivery on `enabled && connected` alone — the status published to the page includes this
     * answer, and the service refuses to claim a delivery it cannot make.
     */
    fun canPost(notificationsEnabled: Boolean, taskChannelBlocked: Boolean): Boolean =
        notificationsEnabled && !taskChannelBlocked
}
