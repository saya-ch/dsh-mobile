package io.github.sayach.dshmobile

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** The published App descriptor, as committed to the plugin repository. */
internal data class AppUpdateInfo(
    val version: String,
    val versionCode: Int,
    val releaseTag: String,
)

/**
 * Reads the App release descriptor straight from GitHub.
 *
 * The descriptor is the same file the plugin publishes (`apps/mobile/release.json`), so
 * the check does not depend on a paired gateway or on the plugin's own update state: a
 * phone whose computer is offline can still learn about a newer signed App.
 */
internal object AppUpdatePolicy {
    const val DESCRIPTOR_URL = "https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/apps/mobile/release.json"
    private const val RELEASE_PAGE_PREFIX = "https://github.com/saya-ch/dsh-mobile/releases/tag/"
    private const val MAX_DESCRIPTOR_BYTES = 16 * 1024
    private val VERSION = Regex("^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$")
    private val RELEASE_TAG = Regex("^android-v\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$")

    /** Public download page for one published Android tag. */
    fun releasePageUrl(releaseTag: String): String = RELEASE_PAGE_PREFIX + releaseTag

    /** A published descriptor only updates the App when its build number is higher. */
    fun isNewer(published: AppUpdateInfo, currentVersionCode: Int): Boolean = published.versionCode > currentVersionCode

    /** Parse a bounded descriptor, rejecting incomplete, inconsistent or oversized payloads. */
    fun parseDescriptor(bytes: ByteArray): AppUpdateInfo? {
        if (bytes.isEmpty() || bytes.size > MAX_DESCRIPTOR_BYTES) return null
        val json = runCatching { JSONObject(String(bytes, Charsets.UTF_8)) }.getOrNull() ?: return null
        val version = json.optString("version")
        val versionCode = json.optInt("versionCode", -1)
        val releaseTag = json.optString("releaseTag")
        if (!VERSION.matches(version) || versionCode <= 0 || !RELEASE_TAG.matches(releaseTag)) return null
        if (releaseTag != "android-v$version") return null
        return AppUpdateInfo(version = version, versionCode = versionCode, releaseTag = releaseTag)
    }

    /** Fetch the descriptor bytes. Callers must run this off the main thread. */
    fun fetchDescriptor(): ByteArray {
        val connection = URL(DESCRIPTOR_URL).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 8_000
            connection.readTimeout = 8_000
            connection.instanceFollowRedirects = true
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "dsh-mobile-android")
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) throw IllegalStateException("descriptor_http_$status")
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(4_096)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > MAX_DESCRIPTOR_BYTES) throw IllegalStateException("descriptor_too_large")
                    output.write(buffer, 0, read)
                }
            }
            output.toByteArray()
        } finally {
            connection.disconnect()
        }
    }
}
