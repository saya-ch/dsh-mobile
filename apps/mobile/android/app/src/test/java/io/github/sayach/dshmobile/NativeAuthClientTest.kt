package io.github.sayach.dshmobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.json.JSONObject
import java.io.ByteArrayInputStream

class NativeAuthClientTest {
    private val origin = GatewayOrigin.parse("https://example.r8.cpolar.cn")!!
    private val instanceId = "a".repeat(64)
    private val now = 1_700_000_000_000L

    @Test
    fun optionalInstallationIdentityIsStrictAndBackwardsCompatible() {
        assertNull(parseSession(validPairResponse(), true).installationId)
        assertEquals("b".repeat(64), parseSession(validPairResponse().put("installationId", "b".repeat(64)), true).installationId)
        assertEquals("b".repeat(64), parseSession(validRenewResponse().put("installationId", "b".repeat(64)), false).installationId)
        val probe = validProbeResponse().put("installationId", "b".repeat(64))
        assertEquals("b".repeat(64), parseNativeProbeResponse(ByteArrayInputStream(probe.toString().toByteArray()), origin, instanceId, now).installationId)
        listOf(JSONObject.NULL, 1, "", "B".repeat(64), "b".repeat(63)).forEach { bad ->
            assertThrows(NativeAuthFailure::class.java) { parseSession(validPairResponse().put("installationId", bad), true) }
            assertThrows(NativeAuthFailure::class.java) {
                parseNativeProbeResponse(ByteArrayInputStream(validProbeResponse().put("installationId", bad).toString().toByteArray()), origin, instanceId, now)
            }
        }
        assertThrows(NativeAuthFailure::class.java) {
            parseSession(validPairResponse().put("installationId", "b".repeat(64)).put("instanceId", "b".repeat(64)), true)
        }
    }

    @Test
    fun readsTheCompleteResponseBeforeTheLimit() {
        val source = "discovery".toByteArray()

        assertArrayEquals(source, readAtMost(ByteArrayInputStream(source), source.size + 1))
    }

    @Test
    fun stopsAtTheConfiguredLimit() {
        val source = byteArrayOf(1, 2, 3, 4, 5)

        assertArrayEquals(byteArrayOf(1, 2, 3), readAtMost(ByteArrayInputStream(source), 3))
    }

    @Test
    fun rejectsANegativeLimit() {
        assertThrows(IllegalArgumentException::class.java) {
            readAtMost(ByteArrayInputStream(byteArrayOf()), -1)
        }
    }

    @Test
    fun parsesStrictPairAndRenewResponses() {
        val paired = parseSession(validPairResponse(), requireDeviceCredential = true)
        assertEquals(origin, paired.origin)
        assertEquals(instanceId, paired.instanceId)
        assertEquals("D".repeat(43), paired.deviceToken)
        assertEquals(now + 60_000, paired.deviceExpiresAt)

        val renewed = parseSession(validRenewResponse(), requireDeviceCredential = false)
        assertEquals(origin, renewed.origin)
        assertNull(renewed.deviceToken)
        assertNull(renewed.deviceExpiresAt)
    }

    @Test
    fun parsesAProbeWithoutAcceptingSessionFields() {
        val probe = parseNativeProbeResponse(
            ByteArrayInputStream(validProbeResponse().toString().toByteArray()),
            origin,
            instanceId,
            now,
        )

        assertEquals(origin, probe.origin)
        assertEquals(instanceId, probe.instanceId)
        assertEquals("d".repeat(32), probe.deviceId)
        assertEquals(now + 60_000, probe.deviceExpiresAt)
    }

    @Test
    fun rejectsProbeResponsesThatContainSessionMaterial() {
        val response = validProbeResponse().put("sessionToken", "S".repeat(43))
        val failure = assertThrows(NativeAuthFailure::class.java) {
            parseNativeProbeResponse(
                ByteArrayInputStream(response.toString().toByteArray()),
                origin,
                instanceId,
                now,
            )
        }
        assertEquals(NativeAuthFailureKind.INVALID_RESPONSE, failure.kind)
    }

    @Test
    fun rejectsMalformedNativeSessions() {
        val malformed = listOf(
            JSONObject(validPairResponse().toString()).apply { remove("csrfToken") },
            JSONObject(validPairResponse().toString()).put("csrfToken", 7),
            JSONObject(validPairResponse().toString()).put("sessionToken", "short"),
            JSONObject(validPairResponse().toString()).put("instanceId", "b".repeat(64)),
            JSONObject(validPairResponse().toString()).put("sessionExpiresAt", now),
            JSONObject(validPairResponse().toString()).put("deviceExpiresAt", now + 10_000)
                .put("sessionExpiresAt", now + 20_000),
            JSONObject(validPairResponse().toString()).put("unexpected", true),
        )

        malformed.forEach { response ->
            val failure = assertThrows(NativeAuthFailure::class.java) {
                parseSession(response, requireDeviceCredential = true)
            }
            assertEquals(NativeAuthFailureKind.INVALID_RESPONSE, failure.kind)
        }
    }

    @Test
    fun rejectsMalformedNativeSessionJson() {
        val failure = assertThrows(NativeAuthFailure::class.java) {
            parseNativeSessionResponse(
                ByteArrayInputStream("not json".toByteArray()),
                origin,
                instanceId,
                requireDeviceCredential = true,
                now = now,
            )
        }

        assertEquals(NativeAuthFailureKind.INVALID_RESPONSE, failure.kind)
    }

    @Test
    fun rejectsOversizedNativeSessionResponses() {
        val failure = assertThrows(NativeAuthFailure::class.java) {
            parseNativeSessionResponse(
                ByteArrayInputStream(ByteArray(MAX_NATIVE_AUTH_RESPONSE_BYTES + 1) { 'x'.code.toByte() }),
                origin,
                instanceId,
                requireDeviceCredential = true,
                now = now,
            )
        }

        assertEquals(NativeAuthFailureKind.INVALID_RESPONSE, failure.kind)
    }

    @Test
    fun parsesBoundedCompatibilityMetadata() {
        assertEquals(
            GatewayMetadata(1, "0.3.0", "0.2.2", 1),
            parseGatewayMetadata(JSONObject("""{"version":1,"pluginVersion":"0.3.0","minimumAndroidAppVersion":"0.2.2","discoveryProtocol":1}""")),
        )
        assertNull(parseGatewayMetadata(JSONObject("{}")))
    }

    @Test
    fun classifiesAuthenticationStatusesWithoutExposingServerBodies() {
        assertEquals(NativeAuthFailureKind.PAIRING_EXPIRED, nativeAuthFailureForStatus(401))
        assertEquals(NativeAuthFailureKind.DEVICE_REVOKED, nativeAuthFailureForStatus(401, "device_revoked"))
        assertEquals(NativeAuthFailureKind.DEVICE_EXPIRED, nativeAuthFailureForStatus(401, "device_expired"))
        assertEquals(NativeAuthFailureKind.SOURCE_NETWORK_UNTRUSTED, nativeAuthFailureForStatus(403, "source_network_untrusted"))
        assertEquals(NativeAuthFailureKind.PAIRING_EXPIRED, nativeAuthFailureForStatus(403))
        assertEquals(NativeAuthFailureKind.DEVICE_LIMIT, nativeAuthFailureForStatus(409))
        assertEquals(NativeAuthFailureKind.RATE_LIMITED, nativeAuthFailureForStatus(429))
        assertEquals(NativeAuthFailureKind.SERVER_UNAVAILABLE, nativeAuthFailureForStatus(503))
    }

    @Test
    fun allowsRemoteRelaysMoreTimeWithoutSlowingLanFailures() {
        val lan = nativeAuthTimeouts("192.168.1.20")
        val remote = nativeAuthTimeouts("example.r8.cpolar.cn")

        assertEquals(500, lan.bootstrapConnectMs)
        assertEquals(800, lan.bootstrapReadMs)
        assertEquals(3_000, lan.authConnectMs)
        assertEquals(5_000, lan.authReadMs)
        assertEquals(3_000, remote.bootstrapConnectMs)
        assertEquals(5_000, remote.bootstrapReadMs)
        assertEquals(10_000, remote.authConnectMs)
        assertEquals(30_000, remote.authReadMs)
    }

    private fun parseSession(response: JSONObject, requireDeviceCredential: Boolean): NativeSession =
        parseNativeSessionResponse(
            ByteArrayInputStream(response.toString().toByteArray()),
            origin,
            instanceId,
            requireDeviceCredential,
            now,
        )

    private fun validPairResponse(): JSONObject = validRenewResponse()
        .put("deviceToken", "D".repeat(43))
        .put("deviceExpiresAt", now + 60_000)

    private fun validRenewResponse(): JSONObject = JSONObject()
        .put("instanceId", instanceId)
        .put("deviceId", "d".repeat(32))
        .put("sessionToken", "S".repeat(43))
        .put("csrfToken", "C".repeat(43))
        .put("sessionExpiresAt", now + 30_000)

    private fun validProbeResponse(): JSONObject = JSONObject()
        .put("instanceId", instanceId)
        .put("deviceId", "d".repeat(32))
        .put("deviceExpiresAt", now + 60_000)

}
