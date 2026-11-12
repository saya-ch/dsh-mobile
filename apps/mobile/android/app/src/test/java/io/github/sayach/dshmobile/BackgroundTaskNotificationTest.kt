package io.github.sayach.dshmobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Issue #400 (Android half): the background completion record must carry plugin-authored text when
 * the announced event provides it, keep one record per Session+turn, and stay out of the way while
 * the live page owns delivery.
 *
 * These are pure-JVM assertions over [BackgroundTaskNotification]; no device, NotificationManager or
 * running Service is involved, which is why the report calls this unit/build evidence only.
 */
class BackgroundTaskNotificationTest {
    private val fallbackTitle = "Task finished"
    private val fallbackBody = "Your DSH task finished"

    @Test
    fun titleAndBodyPreferWellFormedEventText() {
        assertEquals("Fix login flow", BackgroundTaskNotification.title("Fix login flow", fallbackTitle))
        assertEquals(
            "Replace the retry loop",
            BackgroundTaskNotification.body("Replace the retry loop", fallbackBody),
        )
    }

    @Test
    fun missingEventTextFallsBackToTheLocalizedString() {
        assertEquals(fallbackTitle, BackgroundTaskNotification.title(null, fallbackTitle))
        assertEquals(fallbackBody, BackgroundTaskNotification.body(null, fallbackBody))
        assertEquals(fallbackTitle, BackgroundTaskNotification.title("", fallbackTitle))
        assertEquals(fallbackBody, BackgroundTaskNotification.body("", fallbackBody))
        assertEquals(fallbackTitle, BackgroundTaskNotification.title("   \r\n\t ", fallbackTitle))
    }

    @Test
    fun titleAndBodyFallBackIndependently() {
        // A plugin that names the Session but sends no preview still keeps the localized body.
        assertEquals("Fix login flow", BackgroundTaskNotification.title("Fix login flow", fallbackTitle))
        assertEquals(fallbackBody, BackgroundTaskNotification.body(null, fallbackBody))
        assertEquals(fallbackTitle, BackgroundTaskNotification.title(null, fallbackTitle))
        assertEquals("Replace the retry loop", BackgroundTaskNotification.body("Replace the retry loop", fallbackBody))
    }

    @Test
    fun controlCharactersAreDroppedAndNewlinesCollapse() {
        assertEquals(
            "line one line two",
            BackgroundTaskNotification.body("line one\r\nline two\u0000\u0007", fallbackBody),
        )
        // Text made only of control characters is not usable; the fallback wins.
        assertEquals(fallbackBody, BackgroundTaskNotification.body("\u0000\u0001\u0002", fallbackBody))
    }

    @Test
    fun eventTextIsBoundedToTheRecordLimits() {
        val longTitle = "t".repeat(NativeBridgePolicy.TASK_NOTIFICATION_TITLE_CHARS + 120)
        val longBody = "b".repeat(NativeBridgePolicy.TASK_NOTIFICATION_BODY_CHARS + 120)
        assertEquals(
            NativeBridgePolicy.TASK_NOTIFICATION_TITLE_CHARS,
            BackgroundTaskNotification.title(longTitle, fallbackTitle).length,
        )
        assertEquals(
            NativeBridgePolicy.TASK_NOTIFICATION_BODY_CHARS,
            BackgroundTaskNotification.body(longBody, fallbackBody).length,
        )
    }

    @Test
    fun jsonNullMissingAndNonStringTextAreAbsent() {
        val nullTitle = JSONObject("""{"title":null}""")
        assertEquals(fallbackTitle, BackgroundTaskNotification.title(
            BackgroundTaskNotification.eventText(nullTitle, "title"), fallbackTitle,
        ))
        val absent = JSONObject("""{"body":"preview"}""")
        assertEquals(null, BackgroundTaskNotification.eventText(absent, "title"))
        assertEquals("preview", BackgroundTaskNotification.eventText(absent, "body"))
        val nonString = JSONObject("""{"title":42}""")
        assertEquals(null, BackgroundTaskNotification.eventText(nonString, "title"))
        val present = JSONObject("""{"title":"Named session","body":"First line"}""")
        assertEquals("Named session", BackgroundTaskNotification.eventText(present, "title"))
    }

    @Test
    fun tagIsStableForOneSessionAndTurn() {
        val first = BackgroundTaskNotification.tag("session-a", 1)
        val repeated = BackgroundTaskNotification.tag("session-a", 1)
        assertEquals(first, repeated)
        assertTrue(first.startsWith(BackgroundTaskNotification.TAG_PREFIX))
        assertTrue(first.length <= NativeBridgePolicy.TASK_NOTIFICATION_TAG_CHARS)
        // The key is ASCII and never carries the Session id or any other payload text.
        assertTrue(first.all { it in 'a'..'z' || it in '0'..'9' || it == '-' })
        assertFalse(first.contains("session"))
    }

    @Test
    fun tagSeparatesSessionsAndTurns() {
        val base = BackgroundTaskNotification.tag("session-a", 1)
        assertNotEquals(base, BackgroundTaskNotification.tag("session-b", 1))
        assertNotEquals(base, BackgroundTaskNotification.tag("session-a", 2))
        // An empty Session id still produces a usable, distinct key (the service drops such events).
        assertNotEquals(base, BackgroundTaskNotification.tag("", 1))
    }

    @Test
    fun backgroundTagNeverLooksLikeAPageTag() {
        val background = BackgroundTaskNotification.tag("session-a", 3)
        val page = "dsh-task-done-0123456789abcdef0123456789abcdef-3"
        assertNotEquals(page, background)
        assertFalse(background.startsWith("dsh-task-done-"))
        assertTrue(page.startsWith("dsh-task-done-"))
    }

    @Test
    fun repeatedEventForTheSameTurnWritesOneRecord() {
        val records = LinkedHashMap<Pair<String, Int>, String>()
        fun post(sessionId: String, turn: Int, text: String) {
            // Android keys a notification record by (tag, id); the publisher always uses the one
            // TASK_NOTIFICATION_ID, so this map mirrors exactly what the platform would collapse.
            records[BackgroundTaskNotification.tag(sessionId, turn) to NativeBridgePolicy.TASK_NOTIFICATION_ID] = text
        }
        post("session-a", 1, "first delivery")
        post("session-a", 1, "replacement delivery")
        assertEquals(1, records.size)
        assertEquals("replacement delivery", records.values.single())
    }

    @Test
    fun anotherTurnIsASeparateRecord() {
        val records = LinkedHashMap<Pair<String, Int>, String>()
        fun post(sessionId: String, turn: Int) {
            records[BackgroundTaskNotification.tag(sessionId, turn) to NativeBridgePolicy.TASK_NOTIFICATION_ID] = "text"
        }
        post("session-a", 1)
        post("session-a", 2)
        post("session-b", 2)
        assertEquals(3, records.size)
    }

    @Test
    fun canPostRequiresThePermissionAndAnUnblockedChannel() {
        // Both gates open: the record can appear.
        assertTrue(BackgroundTaskNotification.canPost(notificationsEnabled = true, taskChannelBlocked = false))
        // Android 13+ permission revoked: notify() is a silent no-op.
        assertFalse(BackgroundTaskNotification.canPost(notificationsEnabled = false, taskChannelBlocked = false))
        // The task-notification channel switched off at IMPORTANCE_NONE: notify() is also a no-op.
        assertFalse(BackgroundTaskNotification.canPost(notificationsEnabled = true, taskChannelBlocked = true))
        assertFalse(BackgroundTaskNotification.canPost(notificationsEnabled = false, taskChannelBlocked = true))
    }
}
