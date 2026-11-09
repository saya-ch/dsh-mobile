using System.Net;
using System.Net.Sockets;
using System.Text;

namespace DshMobile.Win;

/// <summary>Transport used to reach a paired computer.</summary>
internal enum AccessChannel
{
    Iroh,
    Lan,
    Remote,
}

/// <summary>
/// A validated URL-form pairing link: a bare HTTPS origin or the plugin's fixed
/// one-time pairing URL with an instance/token fragment (legacy LAN) or a
/// dsh1/dsh2 pairing key. Mirrors GatewayConnection.parse, GatewayUrlPolicy.pairingKey
/// and RemoteHostPolicy.kt. The dsh2 prefix and the legacy fragment make the CA
/// bootstrap mandatory; a dsh1 remote key may fall back to platform trust after 404.
/// </summary>
internal sealed record UrlPairing(
    string Hostname,
    int Port,
    string Origin,
    string Token,
    string InstanceId,
    bool RequiresCa,
    bool MayUsePlatformTrust,
    AccessChannel Mode)
{
    internal const int MaxBytes = 2048;

    private const string PairPath = "/mobile-access/pair";

    // instance=<64 hex>&token=<43 base64url> | key=dsh2.<64 hex>.<43 base64url>
    private static readonly string[] AllowedFragments =
    [
        "^instance=[a-f0-9]{64}&token=[A-Za-z0-9_-]{43}$",
        "^key=dsh1\\.[a-f0-9]{64}\\.[A-Za-z0-9_-]{43}$",
        "^key=dsh2\\.[a-f0-9]{64}\\.[A-Za-z0-9_-]{43}$",
    ];

    /// <summary>Canonical serialized origin; the default HTTPS port is omitted.</summary>
    internal static string SerializeOrigin(string host, int port) =>
        port == 443 ? $"https://{HostLiteral(host)}" : $"https://{HostLiteral(host)}:{port}";

    /// <summary>Host header / authority form: IPv6 literals stay bracketed.</summary>
    internal static string HostLiteral(string host) =>
        host.Contains(':') ? $"[{host}]" : host;

    internal static string HostHeader(string host, int port) =>
        port == 443 ? HostLiteral(host) : $"{HostLiteral(host)}:{port}";

    internal static UrlPairing Parse(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || Encoding.UTF8.GetByteCount(raw) > MaxBytes)
            throw new FormatException("配对链接为空或超长");

        var uri = TryUri(raw.Trim()) ?? throw new FormatException("不是有效的 URL");
        if (!uri.IsAbsoluteUri || uri.Scheme != "https")
            throw new FormatException("只接受 https:// 配对链接");
        // Uri.UserInfo / Uri.Query are "" (never null) when absent.
        if (uri.UserInfo.Length > 0 || uri.Query.Length > 0)
            throw new FormatException("配对链接不能包含用户信息或查询参数");
        if (uri.AbsolutePath != PairPath && uri.AbsolutePath != "/" && uri.AbsolutePath != string.Empty)
            throw new FormatException($"配对链接路径必须是 {PairPath}");

        var host = CanonicalHost(uri.Host)
            ?? throw new FormatException("主机名格式无效");
        var port = uri.Port == -1 ? 443 : uri.Port;
        if (port is < 1 or > 65535) throw new FormatException("端口超出范围");

        string? fragment = uri.Fragment.Length > 1 ? uri.Fragment[1..] : null;
        string token;
        string instanceId;
        bool requiresCa;
        if (fragment is null)
        {
            throw new FormatException("缺少配对凭据（fragment 必须包含 instance/token 或 key=…）");
        }
        if (fragment.StartsWith("key=", StringComparison.Ordinal))
        {
            var match = System.Text.RegularExpressions.Regex.Match(
                fragment[4..], "^dsh([12])\\.([a-f0-9]{64})\\.([A-Za-z0-9_-]{43})$");
            if (!match.Success) throw new FormatException("key= 配对码格式无效");
            instanceId = match.Groups[2].Value;
            token = match.Groups[3].Value;
            requiresCa = match.Groups[1].Value == "2";
        }
        else
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(
                    fragment, AllowedFragments[0]))
                throw new FormatException("instance/token 配对码格式无效");
            instanceId = fragment["instance=".Length..][..64];
            var tokenStart = "instance=".Length + 64 + "&token=".Length;
            token = fragment[tokenStart..];
            requiresCa = true;
        }

        var mode = RemoteHostPolicy.IsRemoteCandidate(host) ? AccessChannel.Remote : AccessChannel.Lan;
        // Platform trust is only allowed for a dsh1 remote key when the CA endpoint
        // answers 404 (public-CA gateway); every other case pins the fetched CA.
        var mayUsePlatformTrust = mode == AccessChannel.Remote && !requiresCa;
        return new UrlPairing(host, port, SerializeOrigin(host, port), token,
            instanceId, requiresCa, mayUsePlatformTrust, mode);
    }

    private static Uri? TryUri(string value)
    {
        try { return new Uri(value, UriKind.Absolute); }
        catch (UriFormatException) { return null; }
    }

    /// <summary>Mirrors GatewayOrigin.canonicalHost: lowercase, ASCII, valid labels or IPv6.</summary>
    private static string? CanonicalHost(string rawHost)
    {
        var host = rawHost.Trim().Trim('[').Trim(']').ToLowerInvariant();
        if (host.Length == 0 || host.Any(c => c > 0x7f)) return null;
        if (host.Contains(':'))
        {
            if (host.Contains('%') || host.Count(c => c == ':') < 2) return null;
            if (!host.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f' || c == ':' || c == '.')) return null;
            if (IPAddress.Parse(host).AddressFamily != AddressFamily.InterNetworkV6) return null;
            return host;
        }
        if (host.Length > 253 || host.StartsWith('.') || host.EndsWith('.')) return null;
        foreach (var label in host.Split('.'))
        {
            if (label.Length == 0 || label.Length > 63) return null;
            if (!char.IsLetterOrDigit(label[0]) || !char.IsLetterOrDigit(label[^1])) return null;
            if (label.Any(c => !char.IsLetterOrDigit(c) && c != '-')) return null;
        }
        return host;
    }
}

/// <summary>Classifies remote hosts without treating LAN origins as remote (RemoteHostPolicy.kt).</summary>
internal static class RemoteHostPolicy
{
    private static readonly string[] SupportedSuffixes =
    [
        ".ts.net",
        ".cpolar.cn", ".cpolar.io", ".cpolar.top", ".cpolar.com",
        ".trycloudflare.com",
    ];

    private static readonly (uint Network, int Prefix)[] NonRoutable =
    [
        (0x00000000u, 8), (0x0A000000u, 8), (0x64400000u, 10), (0x7F000000u, 8),
        (0xA9FE0000u, 16), (0xAC100000u, 12), (0xC0000000u, 24), (0xC0000200u, 24),
        (0xC01FC400u, 24), (0xC034C100u, 24), (0xC0586300u, 24), (0xC0A80000u, 16),
        (0xC0AF3000u, 24), (0xC6120000u, 15), (0xC6336400u, 24), (0xCB007100u, 24),
        (0xE0000000u, 4), (0xF0000000u, 4),
    ];

    internal static bool IsRemoteCandidate(string host)
    {
        var normalized = host.ToLowerInvariant().TrimEnd('.');
        if (SupportedSuffixes.Any(normalized.EndsWith)) return true;
        if (normalized.Length == 0 || normalized.Contains(':') || normalized == "localhost" ||
            normalized.EndsWith(".local") || normalized.EndsWith(".lan") ||
            normalized.EndsWith(".home") || normalized.EndsWith(".internal") ||
            normalized.EndsWith(".localhost")) return false;
        if (normalized.Split('.') is { Length: 4 } octets &&
            octets.All(p => p.Length > 0 && p.Length <= 3 && p.All(char.IsDigit)))
        {
            return IsGloballyRoutableIpv4(normalized);
        }
        var labels = normalized.Split('.');
        if (labels.Length < 2 || labels.All(l => l.All(char.IsDigit))) return false;
        return labels.All(l =>
            l.Length > 0 && l.Length <= 63 &&
            char.IsLetterOrDigit(l[0]) && char.IsLetterOrDigit(l[^1]) &&
            l.All(c => char.IsLetterOrDigit(c) || c == '-'));
    }

    private static bool IsGloballyRoutableIpv4(string host)
    {
        var octets = host.Split('.').Select(byte.Parse).ToArray();
        var value = ((uint)octets[0] << 24) | ((uint)octets[1] << 16) | ((uint)octets[2] << 8) | octets[3];
        return !NonRoutable.Any(range =>
        {
            var mask = range.Prefix == 0 ? 0u : uint.MaxValue << (32 - range.Prefix);
            return (value & mask) == range.Network;
        });
    }
}
