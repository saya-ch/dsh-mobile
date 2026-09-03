package io.github.sayach.dshmobile

import java.util.Locale

/** Classifies provider and user-owned remote hosts without treating LAN origins as remote. */
internal object RemoteHostPolicy {
    private val supportedSuffixes = listOf(
        ".ts.net",
        ".cpolar.cn",
        ".cpolar.io",
        ".cpolar.top",
        ".cpolar.com",
    )

    /** Returns whether the host belongs to a supported remote tunnel provider. */
    fun isSupported(host: String): Boolean {
        val normalized = host.lowercase(Locale.ROOT)
        return supportedSuffixes.any(normalized::endsWith)
    }

    /** Returns whether an HTTPS host can represent a user-owned public remote endpoint. */
    fun isRemoteCandidate(host: String): Boolean {
        val normalized = host.lowercase(Locale.ROOT).trimEnd('.')
        if (isSupported(normalized)) return true
        if (isPublicIpv4(normalized)) return true
        if (normalized.isEmpty() || normalized.contains(':') || normalized == "localhost"
            || normalized.endsWith(".local") || normalized.endsWith(".lan")
            || normalized.endsWith(".home") || normalized.endsWith(".internal")) return false
        val labels = normalized.split('.')
        if (labels.size < 2 || labels.all { label -> label.all(Char::isDigit) }) return false
        return labels.all { label ->
            label.isNotEmpty() && label.length <= 63
                && label.first().isLetterOrDigit() && label.last().isLetterOrDigit()
                && label.all { character -> character.isLetterOrDigit() || character == '-' }
        }
    }

    /** Returns whether this origin is valid for the selected connection mode. */
    fun isAllowed(mode: AccessMode, host: String): Boolean = when (mode) {
        AccessMode.LAN -> !isRemoteCandidate(host)
        AccessMode.REMOTE -> isRemoteCandidate(host)
    }

    /** Returns whether the host uses Tailscale and needs the mainland-China connectivity notice. */
    fun needsTailscaleVpnNotice(host: String): Boolean =
        host.lowercase(Locale.ROOT).endsWith(".ts.net")

    /** Accept a literal IPv4 as remote only when it is globally routable (IANA special-purpose excluded). */
    private fun isPublicIpv4(host: String): Boolean {
        val octets = host.split('.').takeIf { it.size == 4 }?.map { part ->
            if (!part.matches(Regex("^(?:0|[1-9][0-9]{0,2})$"))) return false
            part.toInt().takeIf { it in 0..255 } ?: return false
        } ?: return false
        val value = ((octets[0].toLong() shl 24) or (octets[1].toLong() shl 16)
            or (octets[2].toLong() shl 8) or octets[3].toLong())
        // Mirrors TypeScript isGloballyRoutableIpv4: documentation TEST-NET-1/2/3
        // (e.g. 203.0.113.10) and all other non-routable space never qualify.
        return !NON_ROUTABLE_RANGES.any { (network, prefix) ->
            val mask = if (prefix == 0) 0L else (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
            (value and mask) == network
        }
    }

    private val NON_ROUTABLE_RANGES = listOf(
        0x00000000L to 8, // "This network" / software scope
        0x0A000000L to 8, // Private-Use (RFC 1918)
        0x64400000L to 10, // Shared address space / CGNAT (RFC 6598)
        0x7F000000L to 8, // Loopback (RFC 1122)
        0xA9FE0000L to 16, // Link-local (RFC 3927)
        0xAC100000L to 12, // Private-Use (RFC 1918)
        0xC0000000L to 24, // IETF protocol assignments (RFC 6890)
        0xC0000200L to 24, // Documentation TEST-NET-1 (RFC 5737)
        0xC01FC400L to 24, // AS112-v4 (RFC 7534)
        0xC034C100L to 24, // AMT relay (RFC 7450)
        0xC0586300L to 24, // 6to4 relay anycast, deprecated (RFC 7526)
        0xC0A80000L to 16, // Private-Use (RFC 1918)
        0xC0AF3000L to 24, // Direct delegation AS112 (RFC 7535)
        0xC6120000L to 15, // Benchmarking (RFC 2544)
        0xC6336400L to 24, // Documentation TEST-NET-2 (RFC 5737)
        0xCB007100L to 24, // Documentation TEST-NET-3 (RFC 5737)
        0xE0000000L to 4, // Multicast (RFC 1112)
        0xF0000000L to 4, // Reserved for future use + broadcast (RFC 1112)
    )
}
