package io.github.sayach.dshmobile

import java.net.URI

/** A normalized HTTPS origin approved for the dedicated DSH WebView. */
@ConsistentCopyVisibility
internal data class GatewayOrigin private constructor(
    val host: String,
    val port: Int,
) {
    /** The canonical value persisted by the app and safe to share without page state. */
    val serialized: String
        get() {
            val renderedHost = if (host.contains(':')) "[$host]" else host
            val renderedPort = if (port == HTTPS_PORT) "" else ":$port"
            return "https://$renderedHost$renderedPort"
        }

    companion object {
        private const val HTTPS_PORT = 443

        /**
         * Parses a user-entered origin. Paths, queries, fragments, credentials, and
         * every scheme other than HTTPS are rejected instead of being repaired.
         */
        fun parse(rawValue: String): GatewayOrigin? {
            val uri = parseUri(rawValue.trim()) ?: return null
            if (!uri.isAbsolute || uri.isOpaque || uri.scheme?.lowercase() != "https") return null
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            if (uri.rawPath.isNotEmpty() && uri.rawPath != "/") return null
            return fromUri(uri)
        }

        internal fun fromCandidate(uri: URI): GatewayOrigin? {
            if (!uri.isAbsolute || uri.isOpaque || uri.scheme?.lowercase() != "https") return null
            if (uri.rawUserInfo != null) return null
            return fromUri(uri)
        }

        private fun fromUri(uri: URI): GatewayOrigin? {
            val canonicalHost = canonicalHost(uri.host ?: return null) ?: return null
            val explicitPort = uri.port
            if (explicitPort != -1 && explicitPort !in 1..65535) return null
            return GatewayOrigin(canonicalHost, if (explicitPort == -1) HTTPS_PORT else explicitPort)
        }

        private fun canonicalHost(rawHost: String): String? {
            val unwrapped = rawHost.removePrefix("[").removeSuffix("]").lowercase()
            if (unwrapped.isEmpty() || unwrapped.any { it.code > 0x7f }) return null
            if (unwrapped.contains(':')) {
                if (unwrapped.contains('%') || unwrapped.count { it == ':' } < 2) return null
                if (!unwrapped.all { it in '0'..'9' || it in 'a'..'f' || it == ':' || it == '.' }) return null
                return unwrapped
            }
            if (unwrapped.length > 253 || unwrapped.startsWith('.') || unwrapped.endsWith('.')) return null
            val labels = unwrapped.split('.')
            if (labels.any { label ->
                    label.isEmpty() ||
                        label.length > 63 ||
                        !label.first().isLetterOrDigit() ||
                        !label.last().isLetterOrDigit() ||
                        label.any { !it.isLetterOrDigit() && it != '-' }
                }
            ) {
                return null
            }
            return unwrapped
        }

        private fun parseUri(rawValue: String): URI? = runCatching { URI(rawValue) }.getOrNull()
    }
}

/** A safe first page plus the origin that is the only persisted value. */
internal data class GatewayConnection(
    val origin: GatewayOrigin,
    val initialUrl: String,
) {
    companion object {
        private const val PAIR_PATH = "/mobile-access/pair"
        private val PAIR_FRAGMENT = Regex("^(?:instance=[a-f0-9]{64}&token=[A-Za-z0-9_-]{43}|key=dsh2\\.[a-f0-9]{64}\\.[A-Za-z0-9_-]{43})$")

        /** Accepts a bare origin or the plugin's fixed one-time pairing URL. */
        fun parse(rawValue: String): GatewayConnection? {
            GatewayOrigin.parse(rawValue)?.let { return GatewayConnection(it, it.serialized) }
            val uri = runCatching { URI(rawValue.trim()) }.getOrNull() ?: return null
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawPath != PAIR_PATH) return null
            val fragment = uri.rawFragment
            if (fragment != null && !PAIR_FRAGMENT.matches(fragment)) return null
            val origin = GatewayOrigin.fromCandidate(uri) ?: return null
            val initialUrl = buildString {
                append(origin.serialized)
                append(PAIR_PATH)
                if (fragment != null) append('#').append(fragment)
            }
            return GatewayConnection(origin, initialUrl)
        }
    }
}

/** Shared navigation and download decisions for the Android shell. */
internal object GatewayUrlPolicy {
    private val LEGACY_PAIR_FRAGMENT = Regex("^instance=([a-f0-9]{64})&token=([A-Za-z0-9_-]{43})$")
    /** Returns a canonical origin for persistence, or `null` for unsafe input. */
    fun normalizeOrigin(rawValue: String): String? = GatewayOrigin.parse(rawValue)?.serialized

    /** Returns whether an absolute candidate URL has the configured exact origin. */
    fun isSameOrigin(origin: GatewayOrigin, rawCandidate: String): Boolean {
        val candidate = parseCandidate(rawCandidate) ?: return false
        return GatewayOrigin.fromCandidate(candidate) == origin
    }

    /**
     * Returns whether a URL addresses the configured gateway over a secure scheme.
     *
     * Chromium reports WebSocket certificate errors to `onReceivedSslError` with a `wss:` URL while
     * the pinned origin is canonicalized as `https:`, so [isSameOrigin] rejects the very channel a
     * paired page needs and cancels its document. Only the secure scheme family may differ — host
     * and port still have to match exactly.
     */
    fun isPinnedAuthority(origin: GatewayOrigin, rawCandidate: String): Boolean {
        val candidate = parseCandidate(rawCandidate) ?: return false
        if (candidate.scheme?.lowercase() !in PINNED_SCHEMES) return false
        if (candidate.rawUserInfo != null) return false
        val port = if (candidate.port == -1) DEFAULT_HTTPS_PORT else candidate.port
        if (port != origin.port) return false
        val host = candidate.host?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return false
        return host == origin.host
    }

    /** Returns whether a URL may be handed to a system browser. */
    fun isExternalHttps(rawCandidate: String): Boolean {
        val candidate = parseCandidate(rawCandidate) ?: return false
        return GatewayOrigin.fromCandidate(candidate) != null
    }

    /** Extracts the fingerprint-bound key from the plugin's fixed Android pairing URL. */
    fun pairingKey(rawValue: String): PairingKey? {
        val connection = GatewayConnection.parse(rawValue) ?: return null
        val fragment = runCatching { URI(connection.initialUrl).fragment }.getOrNull() ?: return null
        if (fragment.startsWith("key=")) {
            return PairingKey.parse(fragment.removePrefix("key="))?.takeIf { it.requiresCa }
        }
        val match = LEGACY_PAIR_FRAGMENT.matchEntire(fragment) ?: return null
        return PairingKey(match.groupValues[1], match.groupValues[2])
    }

    /**
     * Downloads may start and redirect only within the configured exact origin.
     * Fragments and paths whose HTTP interpretation is ambiguous are rejected.
     */
    fun isAllowedDownload(origin: GatewayOrigin, rawCandidate: String): Boolean {
        val candidate = parseCandidate(rawCandidate) ?: return false
        val path = candidate.path ?: return false
        if (path.contains('\\') || path.split('/').any { it == "." || it == ".." }) return false
        val isAuthenticationControl = path == "/mobile-access" || path.startsWith("/mobile-access/")
        return candidate.rawFragment == null &&
            !isAuthenticationControl &&
            GatewayOrigin.fromCandidate(candidate) == origin
    }

    private fun parseCandidate(rawValue: String): URI? = runCatching { URI(rawValue) }.getOrNull()

    private val PINNED_SCHEMES = setOf("https", "wss")
    private const val DEFAULT_HTTPS_PORT = 443
}
