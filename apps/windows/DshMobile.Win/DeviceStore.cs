using System.IO;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DshMobile.Win;

/// <summary>
/// One paired computer. One-time secrets (irohCode, gatewayToken) are never persisted.
/// The long-lived deviceToken is sealed with Windows DPAPI for the current user before
/// it reaches disk, so the portable folder stays copyable without exposing credentials.
/// The CA is pinned to instanceId again on every load, so a tampered store cannot
/// introduce a new trust anchor.
/// </summary>
internal sealed class SavedDevice
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("DshMobile.Win/device-token/v1");
    private X509Certificate2? _ca;

    public string EndpointId { get; set; } = string.Empty;
    /// <summary>"iroh" (sidecar transport) or "lan"/"remote" (direct HTTPS transport).
    /// Direct devices use the CA instance id as EndpointId, which keeps the store key stable.</summary>
    public string Channel { get; set; } = "iroh";
    public string Name { get; set; } = string.Empty;
    public string Hostname { get; set; } = string.Empty;
    public string Origin { get; set; } = string.Empty;
    public int LocalPort { get; set; }
    public string InstanceId { get; set; } = string.Empty;
    public string CaDerBase64 { get; set; } = string.Empty;
    /// <summary>Direct-only: a dsh1 remote key whose gateway answered 404 for ca.cer
    /// runs on platform trust instead of a pinned pairing CA.</summary>
    public bool PlatformTrust { get; set; }
    public string DeviceId { get; set; } = string.Empty;
    public string ProtectedDeviceToken { get; set; } = string.Empty;
    public long DeviceExpiresAt { get; set; }
    public long PairedAt { get; set; }

    [JsonIgnore]
    internal X509Certificate2 Ca => _ca ??= new X509Certificate2(Convert.FromBase64String(CaDerBase64));

    [JsonIgnore]
    internal bool CanReconnect =>
        !string.IsNullOrEmpty(ProtectedDeviceToken) &&
        !string.IsNullOrEmpty(DeviceId) &&
        DeviceExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000L;

    [JsonIgnore]
    internal string ShortId => EndpointId.Length >= 12 ? EndpointId[..12] : EndpointId;

    [JsonIgnore]
    internal bool HasPinnedCa => CaDerBase64.Length > 0;

    internal static SavedDevice FromDescriptor(PairingDescriptor descriptor) => new()
    {
        Channel = nameof(AccessChannel.Iroh).ToLowerInvariant(),
        EndpointId = descriptor.EndpointId,
        Name = "电脑 " + descriptor.EndpointId[..8],
        Hostname = descriptor.Hostname,
        Origin = descriptor.Origin,
        LocalPort = descriptor.LocalPort,
        InstanceId = descriptor.InstanceId,
        CaDerBase64 = Convert.ToBase64String(descriptor.CaDer),
        PairedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    };

    internal static SavedDevice FromUrlPairing(UrlPairing link) => new()
    {
        Channel = link.Mode.ToString().ToLowerInvariant(),
        EndpointId = link.InstanceId,
        Name = "电脑 " + link.InstanceId[..8],
        Hostname = link.Hostname,
        Origin = link.Origin,
        LocalPort = link.Port,
        InstanceId = link.InstanceId,
        CaDerBase64 = string.Empty, // filled after the ca.cer bootstrap
        PairedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    };

    internal void SetDeviceToken(string token) =>
        ProtectedDeviceToken = Convert.ToBase64String(ProtectedData.Protect(
            Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser));

    internal string? GetDeviceToken()
    {
        if (string.IsNullOrEmpty(ProtectedDeviceToken)) return null;
        try
        {
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(
                Convert.FromBase64String(ProtectedDeviceToken), Entropy, DataProtectionScope.CurrentUser));
        }
        catch (CryptographicException) { return null; } // different user or machine
    }

    /// <summary>Re-verify every persisted trust field before the record may be used.</summary>
    internal void Validate()
    {
        if (Channel is not ("iroh" or "lan" or "remote"))
            throw new FormatException("bad channel");
        if (InstanceId.Length != 64 || !InstanceId.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
            throw new FormatException("bad instanceId");
        if (LocalPort is < 1 or > 65535) throw new FormatException("bad localPort");
        if (Channel == "iroh")
        {
            if (EndpointId.Length != 64 || !EndpointId.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
                throw new FormatException("bad endpointId");
            if (LocalPort is < 1024 or > 65535) throw new FormatException("bad localPort");
            if (Hostname != PairingDescriptor.DeriveHostname(EndpointId) ||
                Origin != $"https://{Hostname}:{LocalPort}")
                throw new FormatException("origin does not match the endpoint identity");
        }
        else
        {
            if (EndpointId != InstanceId) throw new FormatException("direct device key must be the instance id");
            if (Hostname.Length == 0 || Hostname.Any(c => c > 0x7f))
                throw new FormatException("bad direct hostname");
            if (Origin != UrlPairing.SerializeOrigin(Hostname, LocalPort))
                throw new FormatException("origin does not match the direct hostname");
        }

        if (CaDerBase64.Length == 0)
        {
            // Only a dsh1 remote key paired without a CA may run on platform trust;
            // every other channel must carry its pinned pairing CA.
            if (Channel != "remote" || !PlatformTrust) throw new FormatException("missing pinned CA");
            return;
        }
        var der = Convert.FromBase64String(CaDerBase64);
        if (der.Length is 0 or > PairingDescriptor.MaxCaBytes ||
            Convert.ToBase64String(der) != CaDerBase64)
            throw new FormatException("bad CA encoding");
        if (Convert.ToHexString(SHA256.HashData(der)).ToLowerInvariant() != InstanceId)
            throw new FormatException("CA fingerprint does not match instanceId");
        if (!CertificatePolicy.IsSelfSignedCa(Ca)) throw new FormatException("CA is not self-signed");
    }
}

/// <summary>Atomic, tolerant store for the paired-computer list.</summary>
internal sealed class DeviceStore
{
    private readonly string _path;
    private readonly object _gate = new();
    private readonly List<SavedDevice> _items = [];

    internal DeviceStore(string path, Action<string> log)
    {
        _path = path;
        try
        {
            if (!File.Exists(path)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            foreach (var element in doc.RootElement.EnumerateArray())
            {
                try
                {
                    var device = element.Deserialize<SavedDevice>()
                        ?? throw new FormatException("empty record");
                    device.Validate();
                    _items.Add(device);
                }
                catch (Exception error) { log("ignored invalid saved device: " + error.Message); }
            }
            log($"loaded {_items.Count} saved device(s)");
        }
        catch (Exception error) { log("device store unreadable, starting empty: " + error.Message); }
    }

    internal IReadOnlyList<SavedDevice> All
    {
        get { lock (_gate) return _items.OrderByDescending(d => d.PairedAt).ToList(); }
    }

    internal void Upsert(SavedDevice device, Action<string> log)
    {
        lock (_gate)
        {
            var index = _items.FindIndex(d => d.EndpointId == device.EndpointId);
            if (index >= 0)
            {
                device.Name = _items[index].Name;      // keep a user-visible name across renewals
                _items[index] = device;
            }
            else _items.Add(device);
            Save(log);
        }
    }

    internal void Remove(string endpointId, Action<string> log)
    {
        lock (_gate)
        {
            _items.RemoveAll(d => d.EndpointId == endpointId);
            Save(log);
        }
    }

    internal void Rename(string endpointId, string name, Action<string> log)
    {
        lock (_gate)
        {
            var device = _items.FirstOrDefault(d => d.EndpointId == endpointId);
            if (device is null) return;
            device.Name = name;
            Save(log);
        }
    }

    private void Save(Action<string> log)
    {
        try
        {
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var json = JsonSerializer.Serialize(_items, new JsonSerializerOptions { WriteIndented = true });
            var temporary = _path + ".tmp";
            File.WriteAllText(temporary, json, new UTF8Encoding(false));
            File.Move(temporary, _path, overwrite: true);
        }
        catch (Exception error) { log("device store save failed: " + error.Message); }
    }
}
