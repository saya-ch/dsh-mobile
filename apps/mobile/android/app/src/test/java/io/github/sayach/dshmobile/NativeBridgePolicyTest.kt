package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NativeBridgePolicyTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun requestLimitIsEnforcedInUtf8BytesAtTheExactBoundary() {
        assertTrue(NativeBridgePolicy.isMessageWithinLimit("a".repeat(8), 8))
        assertFalse(NativeBridgePolicy.isMessageWithinLimit("a".repeat(9), 8))

        assertTrue(NativeBridgePolicy.isMessageWithinLimit("é".repeat(4), 8))
        assertFalse(NativeBridgePolicy.isMessageWithinLimit("é".repeat(4) + "a", 8))

        assertTrue(NativeBridgePolicy.isMessageWithinLimit("😀😀", 8))
        assertFalse(NativeBridgePolicy.isMessageWithinLimit("😀😀a", 8))
    }

    @Test
    fun malformedSurrogatesMatchTheJvmUtf8ReplacementSize() {
        val malformed = "\uD800x\uDC00"
        val encodedSize = malformed.toByteArray(Charsets.UTF_8).size
        assertTrue(NativeBridgePolicy.isMessageWithinLimit(malformed, encodedSize))
        assertFalse(NativeBridgePolicy.isMessageWithinLimit(malformed, encodedSize - 1))
    }

    @Test
    fun payloadAndReplyLimitsRemainExplicitAndCompatible() {
        assertEquals(8 * 1024 * 1024, NativeBridgePolicy.MAX_BINARY_BYTES)
        assertEquals(256 * 1024, NativeBridgePolicy.MAX_CLIPBOARD_BYTES)
        assertTrue(NativeBridgePolicy.MAX_REPLY_BYTES > NativeBridgePolicy.MAX_BINARY_BYTES * 4 / 3)
    }

    @Test
    fun activityDeadlineIsBoundedAndSurvivesRecreation() {
        val now = 1_000_000L
        val initial = NativeBridgePolicy.resolveActivityDeadline(0L, now)
        assertEquals(now + 5L * 60L * 1000L, initial)
        assertEquals(initial, NativeBridgePolicy.resolveActivityDeadline(initial, now + 20_000L))
        assertEquals(280_000L, NativeBridgePolicy.remainingActivityTimeout(initial, now + 20_000L))
        assertEquals(0L, NativeBridgePolicy.remainingActivityTimeout(initial, initial + 1L))
        assertTrue(NativeBridgePolicy.PAGE_ACTIVITY_TIMEOUT_MS > NativeBridgePolicy.ACTIVITY_REQUEST_TIMEOUT_MS)
    }

    @Test
    fun webMessagesRequireTheExactOriginAndMainFrame() {
        val origin = GatewayOrigin.parse("https://trusted.example:3443")!!
        assertTrue(NativeBridgePolicy.isTrustedMessage(origin, "https://trusted.example:3443", true))
        assertFalse(NativeBridgePolicy.isTrustedMessage(origin, "https://trusted.example:3443", false))
        assertFalse(NativeBridgePolicy.isTrustedMessage(origin, "https://trusted.example.evil:3443", true))
        assertFalse(NativeBridgePolicy.isTrustedMessage(origin, "https://trusted.example", true))
    }

    @Test
    fun cameraCleanupDeletesOnlyStaleNonActiveOrphans() {
        val now = 2 * NativeBridgePolicy.CAMERA_ORPHAN_MAX_AGE_MS
        val stale = temporaryFolder.newFile("dsh-camera-stale.jpg").apply {
            assertTrue(setLastModified(now - NativeBridgePolicy.CAMERA_ORPHAN_MAX_AGE_MS - 1))
        }
        val recent = temporaryFolder.newFile("dsh-camera-recent.jpg").apply {
            assertTrue(setLastModified(now - 1))
        }
        val unrelated = temporaryFolder.newFile("other.jpg").apply {
            assertTrue(setLastModified(1))
        }

        assertTrue(NativeBridgePolicy.isStaleCameraOrphan(stale, null, now))
        assertFalse(NativeBridgePolicy.isStaleCameraOrphan(stale, stale, now))
        assertFalse(NativeBridgePolicy.isStaleCameraOrphan(recent, null, now))
        assertFalse(NativeBridgePolicy.isStaleCameraOrphan(unrelated, null, now))
    }

    @Test
    fun pendingRegistryKeepsDuplicatesAndCapacityAuthoritativeUntilRemoval() {
        val registry = PendingRequestRegistry<String>(2)
        assertTrue(registry.reserve("one", "reading"))
        assertFalse(registry.reserve("one", "duplicate"))
        assertTrue(registry.reserve("two", "waiting"))
        assertFalse(registry.reserve("three", "over capacity"))
        assertEquals("reading", registry["one"])

        assertEquals("reading", registry.remove("one"))
        assertNull(registry["one"])
        assertNull(registry.remove("one"))
        assertTrue(registry.reserve("three", "accepted after terminal reply"))
    }

    @Test
    fun restoredNoCallerOperationIsCleanupOnlyAndNeverReadsPayload() {
        val disposition = RestoredOperationDisposition.CLEANUP_ONLY
        val cameraPlan = restoredNoCallerCleanupPlan(hasCameraFile = true, hasCameraGrant = true)
        val pickerPlan = restoredNoCallerCleanupPlan(hasCameraFile = false, hasCameraGrant = false)

        assertFalse(disposition.requiresPayloadRead())
        assertFalse(cameraPlan.readPayload)
        assertTrue(cameraPlan.revokeGrant)
        assertTrue(cameraPlan.deleteCameraFile)
        assertEquals(
            RestoredOperationCleanupPlan(false, false, false),
            pickerPlan,
        )
    }

    @Test
    fun exportedSnapshotWinsAtomicRaceAgainstOldWorkerDeletion() {
        val ownership = CameraCleanupOwnership<String>()
        val cameraPath = "/cache/native-camera/dsh-camera-race.jpg"

        ownership.markSnapshotExported()
        assertNull(ownership.onTerminal(cameraPath))
        assertTrue(ownership.onDispose(cameraPath, preserveForConfiguration = true).isEmpty())

        // Only the surviving Activity may reclaim deferred cleanup. A recreated
        // Activity instead owns the persisted tombstone path and cleans it there.
        assertEquals(cameraPath, ownership.onHostResumed())
        assertNull(ownership.onHostResumed())
    }

    @Test
    fun terminalAfterSnapshotTransfersDeferredFileWhenOperationHandoffIsNull() {
        val ownership = CameraCleanupOwnership<String>()
        val cameraPath = "/cache/native-camera/dsh-camera-terminal.jpg"

        ownership.markSnapshotExported()
        assertNull(ownership.onTerminal(cameraPath))
        assertEquals(cameraPath, ownership.takeDeferredForHandoff())
        assertTrue(ownership.onDispose(null, preserveForConfiguration = true).isEmpty())
        assertNull(ownership.takeDeferredForHandoff())
    }

    @Test
    fun finalDisposalDrainsDeferredCameraCleanup() {
        val ownership = CameraCleanupOwnership<String>()
        ownership.markSnapshotExported()
        assertNull(ownership.onTerminal("camera.jpg"))
        assertEquals(listOf("camera.jpg"), ownership.onDispose(null, preserveForConfiguration = false))
    }

    @Test
    fun temporaryGrantIsReleasedExactlyOnceByItsOwningResult() {
        val ownership = TemporaryGrantOwnership<String>()
        ownership.claim("content://provider/selected")

        assertNull(ownership.release("content://provider/stale"))
        assertEquals("content://provider/selected", ownership.release("content://provider/selected"))
        assertNull(ownership.release("content://provider/selected"))
        assertNull(ownership.releaseAny())
    }

    @Test
    fun abandonedTemporaryGrantCanBeDrainedWithoutAResultCallback() {
        val ownership = TemporaryGrantOwnership<String>()
        ownership.claim(null)
        assertNull(ownership.releaseAny())

        ownership.claim("content://provider/late")
        assertEquals("content://provider/late", ownership.releaseAny())
        assertNull(ownership.releaseAny())
    }

    @Test
    fun exactOriginRejectsHostPrefixAndPortChanges() {
        val origin = GatewayOrigin.parse("https://trusted.example:3443")!!
        assertTrue(GatewayUrlPolicy.isSameOrigin(origin, "https://trusted.example:3443/session"))
        assertFalse(GatewayUrlPolicy.isSameOrigin(origin, "https://trusted.example.evil:3443/session"))
        assertFalse(GatewayUrlPolicy.isSameOrigin(origin, "https://trusted.example/session"))
    }

    @Test
    fun taskNotificationChannelStaysStable() {
        assertEquals("dsh_task_completion", NativeBridgePolicy.TASK_NOTIFICATION_CHANNEL_ID)
        assertEquals(7101, NativeBridgePolicy.TASK_NOTIFICATION_ID)
        assertEquals(80, NativeBridgePolicy.TASK_NOTIFICATION_TITLE_CHARS)
        assertEquals(200, NativeBridgePolicy.TASK_NOTIFICATION_BODY_CHARS)
        assertEquals(64, NativeBridgePolicy.TASK_NOTIFICATION_TAG_CHARS)
    }

    @Test
    fun notificationTextIsSingleLineBoundedAndControlFree() {
        assertEquals("hi there", NativeBridgePolicy.sanitizeNotificationField("  hi\nthere\u0000", 80))
        assertEquals("a".repeat(80), NativeBridgePolicy.sanitizeNotificationField("a".repeat(200), 80))
        assertEquals("", NativeBridgePolicy.sanitizeNotificationField(" \n ", 80))
    }

    @Test
    fun notificationTagsAreBoundedLowercaseSlugs() {
        assertEquals("dsh-task-done", NativeBridgePolicy.sanitizeNotificationTag("dsh-task-done"))
        assertEquals("q-1-2-pick", NativeBridgePolicy.sanitizeNotificationTag("Q 1/2: pick!"))
        assertEquals("dsh-task", NativeBridgePolicy.sanitizeNotificationTag("!!!"))
        assertTrue(NativeBridgePolicy.sanitizeNotificationTag("x".repeat(100)).length <= 64)
    }
}
