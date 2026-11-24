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

    internal static bool IsHostUnresolved(string? message) =>
        !string.IsNullOrEmpty(message) &&
        (message.Contains("无法解析主机", StringComparison.Ordinal) ||
         message.Contains("No such host", StringComparison.OrdinalIgnoreCase) ||
         message.Contains("nodename nor servname", StringComparison.OrdinalIgnoreCase));

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
                "这台电脑的设备凭据已失效，或电脑端已撤销此设备。\n\n" +
                "请重新生成二维码并完成一次配对。", true);

        if (IsVersionMismatch(message))
            return new ConnectionFailure(ConnectionFailureKind.ProtocolMismatch,
                "客户端与电脑端的协议版本不一致，无法完成配对。\n\n" +
                "请把 Windows 客户端更新到最新版本（设置 → 检查更新），" +
                "并确认电脑端的 DSH Mobile 插件也已更新到兼容版本。", false);

        if (IsWebView2Failure(message))
            return new ConnectionFailure(ConnectionFailureKind.WebView2Unavailable,
                WebView2Availability.MissingMessage, false);

        if (IsCaMismatch(message))
            return new ConnectionFailure(ConnectionFailureKind.CaMismatch,
                "连接到的电脑与配对时固定的不是同一台（CA 指纹不匹配）。\n" +
                "请确认配对链接来自这台电脑，且中间没有地址劫持。", false);

        if (target.IsDirect && IsHostUnresolved(message))
            return new ConnectionFailure(ConnectionFailureKind.HostUnresolved,
                $"无法解析电脑地址 {id}。\n\n" +
                (target.Channel == "lan"
                    ? "局域网连接：请确认本机与电脑在同一网络，电脑端网关正在运行。"
                    : "远程连接：请确认远程通道（Tailscale/cpolar/cloudflared 等）正在运行，且域名可访问。"),
                true);

        if (TryExtractHttpStatus(message, out var status))
        {
            switch (ClassifyHttpStatus(status))
            {
                case ConnectionFailureKind.ProtocolMismatch:
                    return new ConnectionFailure(ConnectionFailureKind.ProtocolMismatch,
                        "电脑端要求升级客户端才能继续（HTTP 426）。\n\n" +
                        "请把 Windows 客户端更新到最新版本（设置 → 检查更新）。", false);
                case ConnectionFailureKind.RateLimited:
                    return new ConnectionFailure(ConnectionFailureKind.RateLimited,
                        "电脑端当前限制了新的连接请求（HTTP 429）。\n\n" +
                        "请等一两分钟再试。如果经常出现，请检查电脑端是否同时有多个客户端在反复重连。",
                        false);
                case ConnectionFailureKind.ServiceUnavailable:
                    return new ConnectionFailure(ConnectionFailureKind.ServiceUnavailable,
                        $"电脑端的 DSH 服务暂时不可用（HTTP {status}）。\n\n" +
                        "请确认电脑端网关与 DSH 本体都在运行，然后重试。", false);
            }
        }

        if (IsTlsFailure(error, message))
            return new ConnectionFailure(ConnectionFailureKind.Tls,
                "与电脑建立安全连接（TLS）失败。\n\n" +
                "常见原因：电脑端证书已更换、代理或 VPN 在做 TLS 拦截、系统时间偏差过大。\n" +
                "请确认电脑端网关正在运行，并重新粘贴该电脑当前的配对链接。", false);

        if (target.IsDirect && IsNetworkFailure(error, message))
        {
            if (target.IsRemote && IsCpolarHost(id))
                return new ConnectionFailure(ConnectionFailureKind.CpolarAddressStale,
                    "cpolar 的临时地址已经失效。\n\n" +
                    "cpolar 免费隧道每次重启都会换域名，保存的地址已经连不到这台电脑。\n" +
                    "请在电脑端打开 DSH Mobile 的远程访问，复制新的配对链接后重新粘贴。", true);
            return new ConnectionFailure(ConnectionFailureKind.Network,
                "无法建立到电脑端网关的 HTTPS 连接。\n\n" +
                (target.Channel == "lan"
                    ? "局域网连接：请确认本机与电脑在同一网络，防火墙放行了网关端口，且通道处于就绪状态。"
                    : "远程连接：请确认远程通道正在运行，公网可访问该地址。"), true);
        }

        if (error is OperationCanceledException || error is TimeoutException)
            return new ConnectionFailure(ConnectionFailureKind.Timeout,
                "连接超时。请确认电脑端 iroh 通道处于就绪状态、两端网络可达，然后重试。", false);

        if (diagnostics?.Contains("No addressing information", StringComparison.OrdinalIgnoreCase) == true)
            return new ConnectionFailure(ConnectionFailureKind.IrohDiscovery,
                "iroh 找不到该电脑端的地址（已自动重试 2 次）。\n\n" +
                $"EndpointId：{ShortId(target)}\n" +
                "请在代理/VPN 中放行 dns.iroh.link、iroh.link、relay.iroh.network 的 DNS 与 UDP。", false);

        if (diagnostics?.Contains("host connection timed out", StringComparison.OrdinalIgnoreCase) == true)
            return new ConnectionFailure(ConnectionFailureKind.IrohDiscovery,
                "iroh 在 15 秒内没能连上配对指向的电脑端（已自动重试 2 次）。\n\n" +
                $"EndpointId：{ShortId(target)}\n" +
                "常见原因：电脑端通道刚重启、发现记录尚未传播，或代理/VPN 拦了 UDP。\n" +
                "请确认通道就绪后重试；详细诊断见 data\\client.log。", false);

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
