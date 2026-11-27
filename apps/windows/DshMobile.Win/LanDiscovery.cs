using System.Net;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

using DshMobile.Win.Resources;

namespace DshMobile.Win;

/// <summary>
/// A gateway found on the LAN, either from a UDP announcement or from a direct
/// probe of GET /mobile-access/discovery. Mirrors Android's LanDiscovery
/// validation: the five fields must agree with each other and with the address
/// that actually answered, so a forged announcement cannot redirect pairing.
/// Discovery is never a trust decision: pairing still pins the CA fingerprint
/// to the instanceId from the one-time link (CertificatePolicy).
/// </summary>
internal sealed record DiscoveredGateway(
    string DeviceName,
    string Hostname,
    int Port,
    string Origin,
    string InstanceId);

/// <summary>LAN gateway discovery: manual address probes and announcement validation.</summary>
internal static class LanDiscovery
{
    internal const int DefaultPort = 3443;
    internal const string DiscoveryPath = "/mobile-access/discovery";
    internal const string DiscoveryQuery = "DSH_MOBILE_DISCOVER_V1";
    private const int MaxResponseBytes = 16 * 1024;

    /// <summary>
    /// Validates one UDP announcement body against the address that sent it.
    /// Returns null with a reason when the announcement must be ignored.
    /// </summary>
    internal static DiscoveredGateway? TryParseAnnouncement(
        string json, string remoteAddress, out string reason)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { reason = "not JSON"; return null; }
        using (doc)
        {
            return ValidatePayload(doc.RootElement, remoteAddress, isUdp: true, out reason);
        }
    }

    /// <summary>
    /// Accepts a bare IP/host, host:port or https://host[:port][/…] and returns
    /// the gateway address to probe. Anything credential-like (userinfo, query,
    /// fragment) is rejected: this box never handles secrets.
    /// </summary>
    internal static (string Host, int Port) NormalizeManualInput(string input)
    {
        if (string.IsNullOrWhiteSpace(input) || Encoding.UTF8.GetByteCount(input) > 512)
            throw new FormatException(Strings.Pairing_AddressEmpty);
        var text = input.Trim();
        if (!text.Contains("://", StringComparison.Ordinal))
            text = "https://" + text;
        Uri uri;
        try { uri = new Uri(text, UriKind.Absolute); }
        catch (UriFormatException) { throw new FormatException(Strings.Pairing_AddressNotUrl); }
        if (!uri.IsAbsoluteUri || uri.Scheme != "https")
            throw new FormatException(Strings.Pairing_AddressMustBeHttps);
        if (uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 1)
            throw new FormatException(Strings.Pairing_AddressSecret);
        var host = UrlPairingCanonicalHost(uri.Host)
            ?? throw new FormatException(Strings.Pairing_HostInvalid);
        // Uri reports 443 for a bare https://host; the gateway default is 3443,
        // so only honor the port when the input actually specified one.
        var authority = text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..]
            .Split('/')[0];
        var hasExplicitPort = authority.StartsWith('[')
            ? authority.Contains("]:", StringComparison.Ordinal)
            : authority.Split(':') is { Length: 2 } parts &&
              parts[1].Length > 0 && parts[1].All(char.IsDigit);
        var port = hasExplicitPort ? uri.Port : DefaultPort;
        if (port is < 1 or > 65535) throw new FormatException(Strings.Pairing_PortInvalid);
        return (host, port);
    }

    /// <summary>
    /// Probes GET /mobile-access/discovery over a TOFU TLS connection and
    /// validates the five fields. Throws on unreachable, malformed or
    /// mismatched gateways; never throws for "no gateway here".
    /// </summary>
    internal static async Task<DiscoveredGateway> ProbeAsync(
        string host, int port, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        var token = deadline.Token;

        var addresses = await Dns.GetHostAddressesAsync(host, token);
        var address = addresses.FirstOrDefault(a =>
                a.AddressFamily == AddressFamily.InterNetwork ||
                a.AddressFamily == AddressFamily.InterNetworkV6)
            ?? throw new InvalidOperationException(string.Format(Strings.Pairing_HostUnresolved, host));
        using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        await socket.ConnectAsync(address, port, token);
        using var network = new NetworkStream(socket, ownsSocket: true);
        using var ssl = new SslStream(network, leaveInnerStreamOpen: false);
        try
        {
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
            {
                TargetHost = host,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                // TOFU for discovery only: the payload is cross-checked against
                // the probed address below, and pairing pins the CA afterwards.
                RemoteCertificateValidationCallback = static (_, _, _, _) => true,
            }, token);
        }
        catch
        {
            ssl.Dispose();
            throw;
        }

        var head = $"GET {DiscoveryPath} HTTP/1.1\r\n" +
                   $"Host: {UrlPairing.HostHeader(host, port)}\r\n" +
                   "Accept: application/json\r\n" +
                   "Connection: close\r\n\r\n";
        await ssl.WriteAsync(Encoding.ASCII.GetBytes(head), token);
        await ssl.FlushAsync(token);
        var raw = await GatewayAuth.ReadHttpResponseAsync(ssl, token, MaxResponseBytes);
        var text = Encoding.UTF8.GetString(raw);
        var split = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (split < 0) throw new InvalidOperationException(Strings.Pairing_DiscoveryHttpFormat);
        if (!text.StartsWith("HTTP/1.1 200 ", StringComparison.Ordinal) &&
            !text.StartsWith("HTTP/1.0 200 ", StringComparison.Ordinal))
            throw new InvalidOperationException(string.Format(
                Strings.Pairing_NotGateway, text.Split("\r\n")[0].Trim()));
        JsonDocument doc;
        try { doc = JsonDocument.Parse(text[(split + 4)..]); }
        catch (JsonException) { throw new InvalidOperationException(Strings.Pairing_DiscoveryNotJson); }
        using (doc)
        {
            return ValidatePayload(doc.RootElement, host, isUdp: false, out var reason)
                ?? throw new InvalidOperationException(
                    string.Format(Strings.Pairing_DiscoveryInvalid, reason));
        }
    }

    private static DiscoveredGateway? ValidatePayload(
        JsonElement root, string remoteAddress, bool isUdp, out string reason)
    {
        reason = string.Empty;
        if (root.ValueKind != JsonValueKind.Object) { reason = "not an object"; return null; }
        // Extra credential-like fields are rejected outright (Android parity).
        foreach (var name in new[] { "token", "secret", "deviceToken", "gatewayToken", "sessionToken" })
        {
            if (HasProperty(root, name)) { reason = "unexpected secret field: " + name; return null; }
        }
        if (!TryGetString(root, "deviceName", out var deviceName) ||
            deviceName.Length == 0 || deviceName.Length > 63 ||
            deviceName.Any(char.IsControl))
        { reason = "bad deviceName"; return null; }
        if (!TryGetString(root, "origin", out var origin) ||
            !TryGetInt(root, "port", out var port) || port is < 1 or > 65535 ||
            !TryGetInt(root, "protocol", out var protocol) || protocol != 1 ||
            !TryGetString(root, "instanceId", out var instanceId) ||
            instanceId.Length != 64 || !instanceId.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
        { reason = "bad origin/port/protocol/instanceId"; return null; }

        Uri originUri;
        try { originUri = new Uri(origin, UriKind.Absolute); }
        catch (UriFormatException) { reason = "bad origin URL"; return null; }
        if (originUri.Scheme != "https") { reason = "origin is not https"; return null; }
        var originHost = NormalizeHost(originUri.Host);
        if (originHost is null) { reason = "bad origin host"; return null; }
        var originPort = originUri.Port == -1 ? 443 : originUri.Port;
        if (originPort != port) { reason = "origin port mismatch"; return null; }
        // The origin must be the address that actually answered. For UDP the
        // sender IP is authoritative; for a manual probe an IP-literal origin
        // must equal the probed host, while a DNS name is accepted (the later
        // CA fingerprint pin is the real trust anchor).
        var remote = NormalizeHost(remoteAddress.Trim().Trim('[', ']'));
        if (isUdp)
        {
            if (remote is null || originHost != remote) { reason = "origin does not match the sender"; return null; }
        }
        else if (IsIpLiteral(originHost))
        {
            if (remote is null || originHost != remote) { reason = "origin does not match the probed address"; return null; }
        }
        return new DiscoveredGateway(deviceName, originHost, originPort,
            UrlPairing.SerializeOrigin(originHost, originPort), instanceId);
    }

    private static bool HasProperty(JsonElement root, string name)
    {
        foreach (var property in root.EnumerateObject())
            if (property.NameEquals(name)) return true;
        return false;
    }

    private static bool TryGetString(JsonElement root, string name, out string value)
    {
        value = string.Empty;
        foreach (var property in root.EnumerateObject())
        {
            if (!property.NameEquals(name)) continue;
            if (property.Value.ValueKind != JsonValueKind.String) return false;
            value = property.Value.GetString() ?? string.Empty;
            return true;
        }
        return false;
    }

    private static bool TryGetInt(JsonElement root, string name, out int value)
    {
        value = 0;
        foreach (var property in root.EnumerateObject())
        {
            if (!property.NameEquals(name)) continue;
            if (property.Value.ValueKind != JsonValueKind.Number ||
                !property.Value.TryGetInt32(out value)) return false;
            return true;
        }
        return false;
    }

    /// <summary>
    /// Broadcasts the discovery query and collects announcements until
    /// <paramref name="listenFor"/> elapses. Binds the gateway port so the
    /// plugin's periodic (3s) announcements are heard too; falls back to an
    /// ephemeral port when the local gateway already owns it (the query still
    /// works because answers go back to the sender endpoint).
    /// </summary>
    internal static async IAsyncEnumerable<DiscoveredGateway> QueryAsync(
        int port,
        TimeSpan listenFor,
        Action<string> log,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct,
        IEnumerable<IPAddress>? targets = null)
    {
        using var client = new UdpClient();
        try
        {
            client.Client.Bind(new IPEndPoint(IPAddress.Any, port));
        }
        catch (Exception error)
        {
            log("discovery listen on port " + port + " failed, using an ephemeral port: " + error.Message);
        }
        client.EnableBroadcast = true;
        var destinations = targets?.Select(t => new IPEndPoint(t, port)).ToList()
            ?? DefaultTargets(port);
        var query = Encoding.ASCII.GetBytes(DiscoveryQuery);

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(listenFor);
        var token = deadline.Token;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var lastSend = DateTime.MinValue;
        while (!token.IsCancellationRequested)
        {
            if (DateTime.UtcNow - lastSend > TimeSpan.FromSeconds(1))
            {
                lastSend = DateTime.UtcNow;
                foreach (var destination in destinations)
                {
                    try { await client.SendAsync(query, destination, token); }
                    catch { /* next target */ }
                }
            }
            Task<UdpReceiveResult> receive;
            try { receive = client.ReceiveAsync(token).AsTask(); }
            catch { yield break; }
            var completed = await Task.WhenAny(receive,
                Task.Delay(TimeSpan.FromSeconds(1), token));
            if (completed != receive) continue;
            UdpReceiveResult result;
            try { result = await receive; }
            catch { continue; }
            var remote = result.RemoteEndPoint.Address.ToString();
            var gateway = TryParseAnnouncement(
                Encoding.UTF8.GetString(result.Buffer), remote, out var reason);
            if (gateway is null)
            {
                log("ignoring discovery reply from " + remote + ": " + reason);
                continue;
            }
            if (seen.Add(gateway.InstanceId)) yield return gateway;
        }
    }

    /// <summary>
    /// Probes every host of the local /24 (except network/broadcast) for a
    /// gateway. Mirrors Android's subnet fallback when announcements and mDNS
    /// find nothing. Refused hosts fail fast; each host gets its own timeout.
    /// </summary>
    internal static async IAsyncEnumerable<DiscoveredGateway> ScanSubnetAsync(
        string localIpv4,
        int port,
        TimeSpan perHostTimeout,
        Action<string> log,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        if (!IPAddress.TryParse(localIpv4, out var local) ||
            local.AddressFamily != AddressFamily.InterNetwork ||
            IPAddress.IsLoopback(local))
        {
            yield break;
        }
        var raw = BitConverter.ToUInt32(local.GetAddressBytes().Reverse().ToArray(), 0);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var semaphore = new SemaphoreSlim(32);
        var tasks = new List<Task<DiscoveredGateway?>>();
        foreach (var candidate in SubnetHosts(localIpv4))
        {
            tasks.Add(ProbeOneAsync(candidate, port, perHostTimeout, semaphore, ct));
        }
        foreach (var task in tasks)
        {
            DiscoveredGateway? gateway;
            try { gateway = await task; }
            catch { continue; }
            if (gateway is not null && seen.Add(gateway.InstanceId))
                yield return gateway;
        }
        log("subnet scan finished");
    }

    /// <summary>All probed hosts of the local /24: .1-.254 except self.</summary>
    internal static List<string> SubnetHosts(string localIpv4)
    {
        var result = new List<string>();
        if (!IPAddress.TryParse(localIpv4, out var local) ||
            local.AddressFamily != AddressFamily.InterNetwork ||
            IPAddress.IsLoopback(local))
        {
            return result;
        }
        var raw = BitConverter.ToUInt32(local.GetAddressBytes().Reverse().ToArray(), 0);
        var network = raw & 0xFFFFFF00u;
        for (var host = 1u; host < 255u; host++)
        {
            var candidate = new IPAddress(BitConverter.GetBytes(network | host).Reverse().ToArray());
            if (!candidate.Equals(local)) result.Add(candidate.ToString());
        }
        return result;
    }

    private static async Task<DiscoveredGateway?> ProbeOneAsync(
        string host, int port, TimeSpan timeout, SemaphoreSlim semaphore, CancellationToken ct)
    {
        await semaphore.WaitAsync(ct);
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(timeout);
            return await ProbeAsync(host, port, deadline.Token);
        }
        catch
        {
            return null;
        }
        finally
        {
            semaphore.Release();
        }
    }

    /// <summary>255.255.255.255 plus the broadcast address of each live IPv4 NIC.</summary>
    internal static List<IPEndPoint> DefaultTargets(int port)
    {
        var targets = new List<IPEndPoint>
        {
            new(IPAddress.Broadcast, port),
        };
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (adapter.OperationalStatus != OperationalStatus.Up) continue;
            foreach (var unicast in adapter.GetIPProperties().UnicastAddresses)
            {
                if (unicast.Address.AddressFamily != AddressFamily.InterNetwork ||
                    IPAddress.IsLoopback(unicast.Address) ||
                    unicast.IPv4Mask is null) continue;
                var broadcast = BroadcastFor(unicast.Address, unicast.IPv4Mask);
                var endpoint = new IPEndPoint(broadcast, port);
                if (!targets.Contains(endpoint)) targets.Add(endpoint);
            }
        }
        return targets;
    }

    internal static IPAddress BroadcastFor(IPAddress address, IPAddress mask)
    {
        var addr = BitConverter.ToUInt32(address.GetAddressBytes().Reverse().ToArray(), 0);
        var netmask = BitConverter.ToUInt32(mask.GetAddressBytes().Reverse().ToArray(), 0);
        var broadcast = addr | ~netmask;
        return new IPAddress(BitConverter.GetBytes(broadcast).Reverse().ToArray());
    }

    private static string? NormalizeHost(string host)
    {
        host = host.Trim().Trim('[', ']').ToLowerInvariant();
        if (host.Length == 0 || host.Any(c => c > 0x7f)) return null;
        if (host.Contains(':'))
        {
            if (!IPAddress.TryParse(host, out var parsed) ||
                parsed.AddressFamily != AddressFamily.InterNetworkV6) return null;
            return parsed.ToString().ToLowerInvariant();
        }
        return host;
    }

    private static bool IsIpLiteral(string host) =>
        IPAddress.TryParse(host, out _);

    /// <summary>Mirrors UrlPairing.CanonicalHost without taking its pairing-URL context.</summary>
    private static string? UrlPairingCanonicalHost(string rawHost)
    {
        var host = rawHost.Trim().Trim('[').Trim(']').ToLowerInvariant();
        if (host.Length == 0 || host.Any(c => c > 0x7f)) return null;
        if (host.Contains(':'))
        {
            if (host.Contains('%') || host.Count(c => c == ':') < 2) return null;
            if (!host.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f' || c == ':' || c == '.')) return null;
            if (!IPAddress.TryParse(host, out var parsed) ||
                parsed.AddressFamily != AddressFamily.InterNetworkV6) return null;
            return parsed.ToString().ToLowerInvariant();
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
