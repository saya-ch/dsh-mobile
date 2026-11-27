using System.Net.Sockets;
using DshMobile.Win.Resources;

namespace DshMobile.Win;

/// <summary>
/// The parts of a connection target that diagnosis needs. Kept as a small value type
/// so the classification stays unit-testable without constructing a saved device.
/// </summary>
internal readonly record struct ConnectionTarget(string Channel, string Hostname)
{
    /// <summary>"lan" / "remote": direct HTTPS to the gateway, no iroh sidecar.</summary>
    internal bool IsDirect => Channel is "lan" or "remote";

    internal bool IsRemote => Channel == "remote";
}

/// <summary>
/// Failure categories the desktop client reports to the user.
/// </summary>
/// <remarks>
/// Mirrors Android's <c>LoadFailure</c> (SecureWebViewClient.kt) plus the cases that
/// only the desktop reconnect path can hit: a revoked device credential, a pinned-CA
/// mismatch, a stale tunnel address and an absent WebView2 runtime. Every category has
/// its own actionable text instead of one generic "connection failed".
/// </remarks>
internal enum ConnectionFailureKind
{
    /// <summary>No specific cause; the raw message is the only detail available.</summary>
    Unknown,
    /// <summary>Device credential expired, revoked, or the gateway rejected the device.</summary>
    CredentialExpired,
    /// <summary>Client and computer disagree about the protocol/version.</summary>
    ProtocolMismatch,
    /// <summary>The presented certificate does not chain to the pairing CA.</summary>
    CaMismatch,
    /// <summary>Hostname resolution failed (LAN hostname, tunnel domain).</summary>
    HostUnresolved,
    /// <summary>TLS handshake failed.</summary>
    Tls,
    /// <summary>Rate limited by the computer's gateway.</summary>
    RateLimited,
    /// <summary>The computer's DSH service is unavailable (5xx).</summary>
    ServiceUnavailable,
    /// <summary>The gateway could not be reached at all.</summary>
    Network,
    /// <summary>A temporary cpolar tunnel address that has rotated away.</summary>
    CpolarAddressStale,
    /// <summary>The attempt ran out of time (or the user cancelled).</summary>
    Timeout,
    /// <summary>iroh discovery could not find or reach the computer.</summary>
    IrohDiscovery,
    /// <summary>The WebView2 runtime is missing, so no page can be shown.</summary>
    WebView2Unavailable,
}

/// <summary>One diagnosis: what went wrong, what to tell the user, and whether to re-pair.</summary>
internal readonly record struct ConnectionFailure(ConnectionFailureKind Kind, string Hint, bool Repair)
{
    /// <summary>True when offering "paste this computer's current pairing link" helps.</summary>
    internal bool IsAdoptable => Kind is ConnectionFailureKind.CredentialExpired
        or ConnectionFailureKind.HostUnresolved
        or ConnectionFailureKind.Network
        or ConnectionFailureKind.CpolarAddressStale;
}

/// <summary>
/// Turns a connect exception plus the iroh sidecar's stderr into one category and one
/// piece of user-facing advice.
/// </summary>
/// <remarks>
/// The categories follow Android's main-frame failure classification
/// (<c>loadFailureForHttpStatus</c>, <c>isCpolarAddressFailure</c>,
/// <c>showLoadFailure</c>) so both products explain the same failure the same way:
/// TLS, expired session, rate limiting, service unavailable, network, and a rotated
/// cpolar address. The desktop adds the two pre-webview failures it can hit — a
/// revoked device credential and a pinned-CA mismatch — plus protocol/version
/// mismatch, which the phone shows as a page-level error.
/// </remarks>
internal static class ConnectionDiagnosis
{
    /// <summary>cpolar's public tunnel suffixes (mirrors RemoteHostPolicy.kt).</summary>
    private static readonly string[] CpolarSuffixes =
        [".cpolar.cn", ".cpolar.io", ".cpolar.top", ".cpolar.com"];

    /// <summary>cpolar gives each free tunnel a host under one of these domains.</summary>
    internal static bool IsCpolarHost(string? hostname)
    {
        if (string.IsNullOrWhiteSpace(hostname)) return false;
        var normalized = hostname.Trim().TrimEnd('.').ToLowerInvariant();
        return CpolarSuffixes.Any(suffix => normalized.EndsWith(suffix, StringComparison.Ordinal));
    }

    /// <summary>Same mapping as Android's loadFailureForHttpStatus.</summary>
    internal static ConnectionFailureKind ClassifyHttpStatus(int status) => status switch
    {
        401 or 403 => ConnectionFailureKind.CredentialExpired,
        426 => ConnectionFailureKind.ProtocolMismatch,
        429 => ConnectionFailureKind.RateLimited,
        >= 500 and <= 599 => ConnectionFailureKind.ServiceUnavailable,
        _ => ConnectionFailureKind.Network,
    };

    /// <summary>Pull "HTTP/1.1 503" style status out of a gateway rejection message.</summary>
    internal static bool TryExtractHttpStatus(string? message, out int status)
    {
        status = 0;
        if (string.IsNullOrEmpty(message)) return false;
        const string marker = "HTTP/1.";
        var start = message.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (start < 0) return false;
        var cursor = start + marker.Length;
        while (cursor < message.Length && char.IsDigit(message[cursor])) cursor++; // version digit(s)
        while (cursor < message.Length && message[cursor] == ' ') cursor++;
        var digits = 0;
        while (cursor < message.Length && char.IsDigit(message[cursor]) && digits < 3)
        {
            status = status * 10 + (message[cursor] - '0');
            cursor++;
            digits++;
        }
        return digits == 3 && status is >= 100 and <= 599;
    }

    /// <summary>
    /// Protocol/version disagreement. The gateway reports it as a code, the client
    /// phrases it in prose; both spellings are recognised.
    /// </summary>
    /// <remarks>
    /// The Chinese entries below are MATCHING TOKENS, not UI copy: they recognise what
    /// the gateway or the sidecar said. They are deliberately not moved into Strings.resx,
    /// because translating them would stop them matching. They do depend on the wording
    /// of the messages this client itself produces; if that wording changes, these
    /// tokens have to change with it.
    /// </remarks>
    internal static bool IsVersionMismatch(string? message)
    {
        if (string.IsNullOrWhiteSpace(message)) return false;
        string[] tokens =
        [
            "protocol_mismatch", "version_mismatch", "protocol mismatch", "version mismatch",
            "unsupported_protocol", "unsupported protocol", "unsupported_version",
            "unsupported version", "incompatible protocol", "incompatible version",
            "protocol version", "client too old", "upgrade required",
            "协议不兼容", "协议版本", "版本不兼容", "版本过低", "客户端版本",
        ];
        return tokens.Any(token => message.Contains(token, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Credential expiry/revocation, as reported by the gateway or the sidecar.</summary>
    internal static bool IsCredentialFailure(string? message, string? diagnostics)
    {
        if (!string.IsNullOrEmpty(message) &&
            (message.Contains("设备凭据", StringComparison.Ordinal) ||
             message.Contains("device_expired", StringComparison.Ordinal) ||
             message.Contains("device_revoked", StringComparison.Ordinal) ||
             message.Contains("device credential", StringComparison.OrdinalIgnoreCase) ||
             message.Contains("401", StringComparison.Ordinal)))
            return true;
        return !string.IsNullOrEmpty(diagnostics) &&
               (diagnostics.Contains("did not acknowledge", StringComparison.OrdinalIgnoreCase) ||
                diagnostics.Contains("pairing rejected", StringComparison.OrdinalIgnoreCase));
    }

    internal static bool IsCaMismatch(string? message) =>
        !string.IsNullOrEmpty(message) &&
        (message.Contains("配对 CA 校验失败", StringComparison.Ordinal) ||
         message.Contains("配对 CA 与二维码指纹不匹配", StringComparison.Ordinal) ||
         message.Contains("CA 指纹不匹配", StringComparison.Ordinal));

    internal static bool IsTlsFailure(Exception error, string? message) =>
        error is System.Security.Authentication.AuthenticationException ||
        (!string.IsNullOrEmpty(message) &&
         (message.Contains("SSL", StringComparison.OrdinalIgnoreCase) ||
          message.Contains("TLS", StringComparison.OrdinalIgnoreCase) ||
          message.Contains("handshake", StringComparison.OrdinalIgnoreCase) ||
          message.Contains("certificate", StringComparison.OrdinalIgnoreCase) ||
          message.Contains("证书", StringComparison.Ordinal) ||
          message.Contains("SecureChannelFailure", StringComparison.OrdinalIgnoreCase)));

    internal static bool IsHostUnresolved(Exception error, string? message) =>
        // The socket error code is language-independent; the message text is not,
        // so it stays only as a fallback for wrapped or re-thrown errors.
        (error is SocketException socket && socket.SocketErrorCode == SocketError.HostNotFound) ||
        (!string.IsNullOrEmpty(message) &&
         (message.Contains("无法解析主机", StringComparison.Ordinal) ||
          message.Contains("No such host", StringComparison.OrdinalIgnoreCase) ||
          message.Contains("nodename nor servname", StringComparison.OrdinalIgnoreCase)));

    internal static bool IsNetworkFailure(Exception error, string? message) =>
        error is System.Net.Sockets.SocketException ||
        (!string.IsNullOrEmpty(message) &&
         (message.Contains("refused", StringComparison.OrdinalIgnoreCase) ||
          message.Contains("timed out", StringComparison.OrdinalIgnoreCase) ||
          message.Contains("无法连接", StringComparison.Ordinal) ||
          message.Contains("unreachable", StringComparison.OrdinalIgnoreCase)));

    internal static bool IsWebView2Failure(string? message) =>
        !string.IsNullOrEmpty(message) && message.Contains("WebView2", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Classify one failure. The order is deliberate: a gateway rejection carrying a
    /// status code is more specific than the socket error that delivered it, and a
    /// pinned-CA mismatch must never be reported as a generic TLS problem.
    /// </summary>
    internal static ConnectionFailure Diagnose(Exception error, string? diagnostics, ConnectionTarget target)
    {
        var message = error.Message;
        var id = target.Hostname;

        if (IsCredentialFailure(message, diagnostics))
            return new ConnectionFailure(ConnectionFailureKind.CredentialExpired,
                Strings.Diagnosis_CredentialExpired, true);

        if (IsVersionMismatch(message))
            return new ConnectionFailure(ConnectionFailureKind.ProtocolMismatch,
                Strings.Diagnosis_ProtocolMismatch, false);

        if (IsWebView2Failure(message))
            return new ConnectionFailure(ConnectionFailureKind.WebView2Unavailable,
                WebView2Availability.MissingMessage, false);

        if (IsCaMismatch(message))
            return new ConnectionFailure(ConnectionFailureKind.CaMismatch,
                Strings.Diagnosis_CaMismatch, false);

        if (target.IsDirect && IsHostUnresolved(error, message))
        {
            // A cpolar tunnel that has been rotated leaves a hostname that no longer
            // exists, so the useful advice is "re-pair", not "check your network".
            if (target.IsRemote && IsCpolarHost(id))
                return new ConnectionFailure(ConnectionFailureKind.CpolarAddressStale,
                    Strings.Diagnosis_CpolarStale, true);
            return new ConnectionFailure(ConnectionFailureKind.HostUnresolved,
                string.Format(Strings.Diagnosis_HostUnresolved, id,
                    target.Channel == "lan"
                        ? Strings.Diagnosis_HostUnresolvedLan
                        : Strings.Diagnosis_HostUnresolvedRemote),
                true);
        }

        if (TryExtractHttpStatus(message, out var status))
        {
            switch (ClassifyHttpStatus(status))
            {
                case ConnectionFailureKind.ProtocolMismatch:
                    return new ConnectionFailure(ConnectionFailureKind.ProtocolMismatch,
                        Strings.Diagnosis_Http426, false);
                case ConnectionFailureKind.RateLimited:
                    return new ConnectionFailure(ConnectionFailureKind.RateLimited,
                        Strings.Diagnosis_Http429, false);
                case ConnectionFailureKind.ServiceUnavailable:
                    return new ConnectionFailure(ConnectionFailureKind.ServiceUnavailable,
                        string.Format(Strings.Diagnosis_ServiceUnavailable, status), false);
            }
        }

        if (IsTlsFailure(error, message))
            return new ConnectionFailure(ConnectionFailureKind.Tls,
                Strings.Diagnosis_TlsFailure, false);

        if (target.IsDirect && IsNetworkFailure(error, message))
        {
            if (target.IsRemote && IsCpolarHost(id))
                return new ConnectionFailure(ConnectionFailureKind.CpolarAddressStale,
                    Strings.Diagnosis_CpolarStale, true);
            return new ConnectionFailure(ConnectionFailureKind.Network,
                string.Format(Strings.Diagnosis_NetworkFailure,
                    target.Channel == "lan"
                        ? Strings.Diagnosis_NetworkLan
                        : Strings.Diagnosis_NetworkRemote), true);
        }

        if (error is OperationCanceledException || error is TimeoutException)
            return new ConnectionFailure(ConnectionFailureKind.Timeout,
                Strings.Diagnosis_Timeout, false);

        if (diagnostics?.Contains("No addressing information", StringComparison.OrdinalIgnoreCase) == true)
            return new ConnectionFailure(ConnectionFailureKind.IrohDiscovery,
                string.Format(Strings.Diagnosis_IrohNoAddress, ShortId(target)), false);

        if (diagnostics?.Contains("host connection timed out", StringComparison.OrdinalIgnoreCase) == true)
            return new ConnectionFailure(ConnectionFailureKind.IrohDiscovery,
                string.Format(Strings.Diagnosis_IrohConnectTimeout, ShortId(target)), false);

        return new ConnectionFailure(ConnectionFailureKind.Unknown, message, false);
    }

    /// <summary>
    /// Direct (lan/remote) failures worth offering an address update for: the gateway
    /// moved or the credential expired/revoked. iroh records carry their own endpoint
    /// identity and reconnect via Hello instead.
    /// </summary>
    internal static bool IsAdoptable(Exception error, ConnectionTarget target) =>
        target.IsDirect && Diagnose(error, null, target).IsAdoptable;

    private static string ShortId(ConnectionTarget target) =>
        target.Hostname.Length > 24 ? target.Hostname[..24] : target.Hostname;
}
