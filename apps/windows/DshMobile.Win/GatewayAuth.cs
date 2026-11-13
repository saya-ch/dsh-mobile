using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace DshMobile.Win;

internal sealed record NativeSession(
    string SessionToken,
    string CsrfToken,
    long SessionExpiresAt,
    string DeviceId = "",
    string DeviceToken = "",
    long DeviceExpiresAt = 0);

/// <summary>
/// Completes the second, independent authorization layer over the TLS carrier.
/// First pairing redeems the one-time token; later launches renew the session
/// with the persisted deviceToken and never need a QR code again.
///
/// Two transports share one code path:
/// - iroh: a raw SslStream to the loopback proxy that forwards opaque TLS bytes to
///   the remote Gateway (mirrors Android's HttpsURLConnection with a pinned
///   SSLSocketFactory; HttpClient would layer a second TLS handshake on the stream).
/// - lan/remote: a raw SslStream straight to the gateway origin, pinned to the
///   fetched pairing CA, or platform trust for a CA-less dsh1 remote key.
/// </summary>
internal static class GatewayAuth
{
    private const int MaxResponseBytes = 64 * 1024;
    private const int MaxCaBytes = 4096;

    internal static Task<NativeSession> PairAsync(SavedDevice device, string gatewayToken, CancellationToken ct) =>
        PostAsync(device, "/mobile-access/auth/native-pair",
            JsonSerializer.Serialize(new { token = gatewayToken, label = "DeepSeek Harness Windows" }),
            requireDeviceCredential: true, ct);

    internal static Task<NativeSession> RenewAsync(SavedDevice device, string deviceToken, CancellationToken ct) =>
        PostAsync(device, "/mobile-access/auth/native-renew",
            JsonSerializer.Serialize(new { deviceToken }),
            requireDeviceCredential: false, ct);

    /// <summary>
    /// Re-trust bootstrap (PairingTrust.selectTrustAnchor): fetch /mobile-access/ca.cer
    /// over a TOFU connection, then anchor it with the instance-id fingerprint from the
    /// pairing link. Returns null only when PairingTrustPolicy allows platform trust
    /// (explicit 404 for a public-CA remote key). A dsh2 key, a LAN entry or an
    /// already-pinned device fails closed. Any other failure throws.
    /// </summary>
    internal static async Task<X509Certificate2?> FetchCaAsync(SavedDevice device, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        var token = deadline.Token;

        var head = $"GET /mobile-access/ca.cer HTTP/1.1\r\n" +
                   $"Host: {UrlPairing.HostHeader(device.Hostname, device.LocalPort)}\r\n" +
                   "Accept: application/x-x509-ca-cert, */*\r\n" +
                   "Connection: close\r\n\r\n";

        using var ssl = await ConnectAsync(device, bootstrap: true, token);
        await ssl.WriteAsync(Encoding.ASCII.GetBytes(head), token);
        await ssl.FlushAsync(token);
        var raw = await ReadResponseAsync(ssl, token, MaxCaBytes * 4);
        var headerEnd = HeaderEnd(raw);
        if (headerEnd < 0) throw new InvalidOperationException("invalid ca.cer HTTP response");
        var headers = Encoding.ASCII.GetString(raw, 0, headerEnd);
        var statusLine = headers.Split("\r\n")[0];
        var statusParts = statusLine.Split(' ');
        if (statusParts.Length < 2 || !int.TryParse(statusParts[1], out var status))
            throw new InvalidOperationException("invalid ca.cer HTTP status");
        // Mirrors Android RemotePairingTrust.decide. A 404 is only a legitimate
        // platform-trust answer for a public-CA remote key; dsh2, LAN and any
        // already-pinned device must fail closed instead of silently downgrading.
        var outcome = PairingTrustPolicy.Decide(status, device);
        if (outcome == CaBootstrapOutcome.PlatformTrust) return null;
        if (outcome == CaBootstrapOutcome.Reject)
            throw new InvalidOperationException($"获取配对 CA 失败: {statusLine.Trim()}");
        var body = raw[(headerEnd + 4)..];
        if (headers.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase))
            body = DecodeChunkedBytes(body);
        else
        {
            foreach (var line in headers.Split("\r\n"))
            {
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase) &&
                    int.TryParse(line[15..].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var length) &&
                    body.Length > length)
                    body = body[..length];
            }
        }
        // The gateway serves the CA as raw DER (application/pkix-cert), so the body
        // must be read as bytes. A base64 text body is accepted too, for gateways
        // that encoded it instead.
        byte[] der;
        if (body.Length > 0 && body[0] == 0x30)
            der = body;
        else
        {
            var text = Encoding.ASCII.GetString(body).Trim();
            if (text.Length == 0) throw new InvalidOperationException("ca.cer 响应为空");
            der = Convert.FromBase64String(text);
        }
        var ca = CertificatePolicy.ValidateFetchedCa(der, device.InstanceId)
            ?? throw new InvalidOperationException("配对 CA 与二维码指纹不匹配，连接的电脑可能不是二维码指向的那台");
        return ca;
    }

    private static async Task<SslStream> ConnectAsync(SavedDevice device, bool bootstrap, CancellationToken token)
    {
        var addresses = await Dns.GetHostAddressesAsync(device.Hostname, token);
        var address = addresses.FirstOrDefault(a =>
                a.AddressFamily == AddressFamily.InterNetwork || a.AddressFamily == AddressFamily.InterNetworkV6)
            ?? throw new InvalidOperationException($"无法解析主机 {device.Hostname}");
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        await socket.ConnectAsync(address, device.LocalPort, token);
        var network = new NetworkStream(socket, ownsSocket: true);
        var ssl = new SslStream(network, leaveInnerStreamOpen: false);
        try
        {
            var options = new SslClientAuthenticationOptions
            {
                TargetHost = device.Hostname,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
            };
            if (device.HasPinnedCa)
                options.RemoteCertificateValidationCallback = (_, cert, _, _) =>
                    CertificatePolicy.ValidateLeaf(cert is null ? null : new X509Certificate2(cert),
                        device.Ca, device.Hostname);
            else if (bootstrap && !device.PlatformTrust)
                // TOFU: the pairing CA is self-signed, so the platform chain check
                // always fails with PartialChain. Accept the handshake only to fetch
                // /mobile-access/ca.cer; the real trust decision is the instance-id
                // fingerprint check on that CA (ValidateFetchedCa).
                options.RemoteCertificateValidationCallback = static (_, _, _, _) => true;
            else if (!bootstrap && !device.PlatformTrust)
                throw new InvalidOperationException("没有信任锚：缺少配对 CA 且不允许平台信任");
            // A platform-trust device (dsh1 remote, 404 ca.cer) gets Schannel default
            // validation by leaving the callback unset.
            await ssl.AuthenticateAsClientAsync(options, token);
            return ssl;
        }
        catch
        {
            ssl.Dispose();
            throw;
        }
    }

    private static async Task<NativeSession> PostAsync(
        SavedDevice device, string path, string payload, bool requireDeviceCredential, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(20));
        var token = deadline.Token;

        var body = Encoding.UTF8.GetBytes(payload);
        var isIroh = device.Channel == "iroh";
        var head = $"POST {path} HTTP/1.1\r\n" +
                   $"Host: {(isIroh ? $"{device.Hostname}:{device.LocalPort}"
                       : UrlPairing.HostHeader(device.Hostname, device.LocalPort))}\r\n" +
                   "Content-Type: application/json\r\n" +
                   $"Origin: {device.Origin}\r\n" +
                   "Sec-Fetch-Site: same-origin\r\n" +
                   "X-DSH-Mobile-Capabilities: installation-id\r\n" +
                   "Accept: application/json\r\n" +
                   $"Content-Length: {body.Length}\r\n" +
                   "Connection: close\r\n\r\n";

        using var ssl = isIroh
            ? await ConnectLoopbackAsync(device, token)
            : await ConnectAsync(device, bootstrap: false, token);
        await ssl.WriteAsync(Encoding.ASCII.GetBytes(head), token);
        await ssl.WriteAsync(body, token);
        await ssl.FlushAsync(token);

        var raw = await ReadResponseAsync(ssl, token, MaxResponseBytes);
        return ParseHttpResponse(raw, device.InstanceId, requireDeviceCredential);
    }

    /// <summary>The iroh loopback proxy forwards raw TLS bytes; connect to 127.0.0.1 only.</summary>
    private static async Task<SslStream> ConnectLoopbackAsync(SavedDevice device, CancellationToken token)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        await socket.ConnectAsync(IPAddress.Loopback, device.LocalPort, token);
        var network = new NetworkStream(socket, ownsSocket: true);
        var ssl = new SslStream(network, leaveInnerStreamOpen: false);
        try
        {
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
            {
                TargetHost = device.Hostname,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                RemoteCertificateValidationCallback = (_, cert, _, _) =>
                    CertificatePolicy.ValidateLeaf(cert is null ? null : new X509Certificate2(cert),
                        device.Ca, device.Hostname),
            }, token);
            return ssl;
        }
        catch
        {
            ssl.Dispose();
            throw;
        }
    }

    private static async Task<byte[]> ReadResponseAsync(Stream stream, CancellationToken token, int maxBytes)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[4096];
        while (buffer.Length < maxBytes)
        {
            var read = await stream.ReadAsync(chunk, token);
            if (read == 0) break;
            buffer.Write(chunk, 0, read);
            if (HasCompleteBody(buffer.GetBuffer().AsSpan(0, (int)buffer.Length))) break;
        }
        if (buffer.Length >= maxBytes)
            throw new InvalidOperationException($"auth response exceeds {maxBytes} bytes");
        return buffer.ToArray();
    }

    /// <summary>Offset of the CRLFCRLF header terminator, or -1 while headers are incomplete.</summary>
    private static int HeaderEnd(ReadOnlySpan<byte> raw)
    {
        for (var i = 0; i + 3 < raw.Length; i++)
            if (raw[i] == (byte)'\r' && raw[i + 1] == (byte)'\n' &&
                raw[i + 2] == (byte)'\r' && raw[i + 3] == (byte)'\n')
                return i;
        return -1;
    }

    private static bool HasCompleteBody(ReadOnlySpan<byte> raw)
    {
        var split = HeaderEnd(raw);
        if (split < 0) return false;
        var headers = Encoding.ASCII.GetString(raw[..split]);
        // Byte counts, not character counts: ca.cer carries raw DER, where a UTF-8
        // decode would misreport the body length.
        var body = raw[(split + 4)..];
        if (headers.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase))
            return body.EndsWith("\r\n0\r\n\r\n"u8) || body.EndsWith("0\r\n\r\n"u8);
        foreach (var line in headers.Split("\r\n"))
        {
            if (!line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) continue;
            if (int.TryParse(line[15..].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var length))
                return body.Length >= length;
        }
        return false;
    }

    private static NativeSession ParseHttpResponse(byte[] raw, string instanceId, bool requireDeviceCredential)
    {
        var text = Encoding.UTF8.GetString(raw);
        var split = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (split < 0) throw new InvalidOperationException("invalid auth HTTP response");
        var headers = text[..split];
        var body = text[(split + 4)..];
        var statusLine = headers.Split("\r\n")[0];
        var statusParts = statusLine.Split(' ');
        // native-pair replies 201, native-renew replies 200. Accept any 2xx.
        if (statusParts.Length < 2 || !int.TryParse(statusParts[1], out var status) || status is < 200 or > 299)
            throw new InvalidOperationException($"Gateway rejected auth: {statusLine.Trim()} {Trim(body)}");
        if (headers.Contains("Transfer-Encoding: chunked", StringComparison.OrdinalIgnoreCase))
            body = DecodeChunked(body);
        else
        {
            foreach (var line in headers.Split("\r\n"))
            {
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase) &&
                    int.TryParse(line[15..].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var length) &&
                    body.Length > length)
                    body = body[..length];
            }
        }
        return ParseSession(body, instanceId, requireDeviceCredential);
    }

    private static string DecodeChunked(string text)
    {
        var result = new StringBuilder();
        var position = 0;
        while (position < text.Length)
        {
            var eol = text.IndexOf("\r\n", position, StringComparison.Ordinal);
            if (eol < 0) break;
            var sizeText = text[position..eol].Split(';')[0].Trim();
            if (!int.TryParse(sizeText, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var size)) break;
            position = eol + 2;
            if (size == 0) break;
            if (position + size > text.Length) break;
            result.Append(text, position, size);
            position += size + 2;
        }
        return result.ToString();
    }

    /// <summary>Chunked framing is ASCII, but the payload may be binary (ca.cer DER).</summary>
    private static byte[] DecodeChunkedBytes(byte[] raw)
    {
        using var result = new MemoryStream();
        var position = 0;
        while (position < raw.Length)
        {
            var eol = Array.IndexOf(raw, (byte)'\r', position);
            if (eol < 0) break;
            var sizeText = Encoding.ASCII.GetString(raw, position, eol - position).Split(';')[0].Trim();
            if (!int.TryParse(sizeText, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var size)) break;
            position = eol + 2;
            if (size == 0) break;
            if (position + size > raw.Length) break;
            result.Write(raw, position, size);
            position += size + 2;
        }
        return result.ToArray();
    }

    /// <summary>
    /// Matches parseNativeSessionResponse in NativeAuthClient.kt: exact field set,
    /// optional installationId, and device credentials required only for native-pair.
    /// </summary>
    private static NativeSession ParseSession(string payload, string expectedInstanceId, bool requireDeviceCredential)
    {
        using var doc = JsonDocument.Parse(payload);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("invalid auth response");
        var required = new List<string>
        {
            "instanceId", "deviceId", "sessionToken", "csrfToken", "sessionExpiresAt",
        };
        if (requireDeviceCredential) { required.Add("deviceToken"); required.Add("deviceExpiresAt"); }
        var names = root.EnumerateObject().Select(p => p.Name)
            .Where(n => n != "installationId").OrderBy(n => n).ToArray();
        if (!names.SequenceEqual(required.OrderBy(n => n)))
            throw new InvalidOperationException("unexpected auth response fields");
        if (root.GetProperty("instanceId").GetString() != expectedInstanceId)
            throw new InvalidOperationException("auth instanceId mismatch");
        string Str(string name)
        {
            var value = root.GetProperty(name).GetString();
            if (string.IsNullOrEmpty(value)) throw new InvalidOperationException($"empty {name}");
            return value;
        }
        var expires = root.GetProperty("sessionExpiresAt").GetInt64();
        if (expires <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            throw new InvalidOperationException("auth session already expired");
        if (!requireDeviceCredential)
            return new NativeSession(Str("sessionToken"), Str("csrfToken"), expires, Str("deviceId"));

        var deviceExpires = root.GetProperty("deviceExpiresAt").GetInt64();
        if (deviceExpires <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            throw new InvalidOperationException("device credential already expired");
        return new NativeSession(Str("sessionToken"), Str("csrfToken"), expires,
            Str("deviceId"), Str("deviceToken"), deviceExpires);
    }

    private static string Trim(string value) => value.Length <= 200 ? value : value[..200];
}
