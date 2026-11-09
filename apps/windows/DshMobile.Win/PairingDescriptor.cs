using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace DshMobile.Win;

/// <summary>
/// Strict parser for the dsh-mobile-iroh pairing QR payload.
/// Mirrors src/iroh-pairing.ts and IrohPairingDescriptor.kt: exact flat field set,
/// identity-derived origin, self-signed CA whose SHA-256 DER fingerprint is instanceId.
/// </summary>
internal sealed record PairingDescriptor(
    string EndpointId,
    int LocalPort,
    string Hostname,
    string Origin,
    string IrohCode,
    string GatewayToken,
    X509Certificate2 Ca,
    byte[] CaDer,
    string InstanceId,
    long ExpiresAt)
{
    internal const int MaxBytes = 2200;
    internal const int MaxCaBytes = 1536;
    internal const long MaxLifetimeMs = 600_000L;

    private static readonly string[] Fields =
    [
        "version", "type", "endpointId", "origin", "localPort", "irohCode",
        "gatewayToken", "caCertificate", "instanceId", "expiresAt"
    ];

    private static string Hex64(string value) =>
        value.Length == 64 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')
            ? value
            : throw new FormatException("invalid 64-char lowercase hex id");

    internal static string DeriveHostname(string endpointId) =>
        $"{endpointId[..32]}.{endpointId[32..]}.iroh.localhost";

    /// <summary>Canonical base64url without padding, exactly 32 bytes.</summary>
    internal static byte[] DecodeBase64Url32(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        byte[] raw;
        try { raw = Convert.FromBase64String(padded); }
        catch { throw new FormatException("gatewayToken is not base64url"); }
        if (raw.Length != 32 || value != Convert.ToBase64String(raw)
                .TrimEnd('=').Replace('+', '-').Replace('/', '_'))
            throw new FormatException("gatewayToken is not canonical 32-byte base64url");
        return raw;
    }

    internal static PairingDescriptor Parse(string encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded) || Encoding.UTF8.GetByteCount(encoded) > MaxBytes)
            throw new FormatException("pairing descriptor is empty or oversized");

        using var doc = JsonDocument.Parse(encoded, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 2,
        });
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
            throw new FormatException("pairing descriptor must be a flat object");

        var props = doc.RootElement.EnumerateObject().ToList();
        if (props.Count != Fields.Length ||
            !props.Select(p => p.Name).OrderBy(n => n).SequenceEqual(Fields.OrderBy(n => n)) ||
            props.Any(p => p.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array))
            throw new FormatException("pairing descriptor fields do not match the contract");

        string Str(string name) => props.Single(p => p.Name == name).Value.ValueKind == JsonValueKind.String
            ? props.Single(p => p.Name == name).Value.GetString()!
            : throw new FormatException($"{name} must be a string");
        long Int(string name)
        {
            var v = props.Single(p => p.Name == name).Value;
            if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n) || n < 0)
                throw new FormatException($"{name} must be a non-negative integer");
            return n;
        }

        if (Int("version") != 1 || Str("type") != "dsh-mobile-iroh-pairing")
            throw new FormatException("unsupported pairing descriptor version");

        var endpointId = Hex64(Str("endpointId"));
        var portLong = Int("localPort");
        if (portLong is < 1024 or > 65535) throw new FormatException("localPort out of range");
        var port = (int)portLong;
        var hostname = DeriveHostname(endpointId);
        var origin = $"https://{hostname}:{port}";
        if (Str("origin") != origin) throw new FormatException("origin does not match the endpoint identity");

        var code = Str("irohCode");
        if (code.Length != 6 || !code.All(c => c is >= '0' and <= '9'))
            throw new FormatException("irohCode must be six decimal digits");

        var token = Str("gatewayToken");
        DecodeBase64Url32(token);

        var instanceId = Hex64(Str("instanceId"));
        var now = DateTimeOffset.UtcNow;
        var nowMs = now.ToUnixTimeMilliseconds();
        var expiresAt = Int("expiresAt");
        if (expiresAt <= nowMs || expiresAt - nowMs > MaxLifetimeMs)
            throw new FormatException("pairing descriptor expired or lifetime too long");

        var caText = Str("caCertificate");
        if (caText.Length == 0 || caText.Length > 2048)
            throw new FormatException("caCertificate length out of range");
        byte[] der;
        try { der = Convert.FromBase64String(caText); }
        catch { throw new FormatException("caCertificate is not base64"); }
        if (der.Length == 0 || der.Length > MaxCaBytes || Convert.ToBase64String(der) != caText)
            throw new FormatException("caCertificate is not canonical base64 DER");
        if (Convert.ToHexString(SHA256.HashData(der)).ToLowerInvariant() != instanceId)
            throw new FormatException("CA fingerprint does not match instanceId");

        X509Certificate2 ca;
        try { ca = new X509Certificate2(der); }
        catch { throw new FormatException("caCertificate is not an X.509 certificate"); }
        if (!ca.RawData.SequenceEqual(der) || !CertificatePolicy.IsSelfSignedCa(ca))
            throw new FormatException("caCertificate must be a self-signed CA");
        if (now.UtcDateTime < ca.NotBefore.ToUniversalTime() ||
            DateTimeOffset.FromUnixTimeMilliseconds(expiresAt).UtcDateTime > ca.NotAfter.ToUniversalTime())
            throw new FormatException("CA validity does not cover the pairing window");

        return new PairingDescriptor(endpointId, port, hostname, origin, code, token, ca, der, instanceId, expiresAt);
    }
}
