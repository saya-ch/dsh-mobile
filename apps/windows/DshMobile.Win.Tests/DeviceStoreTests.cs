using Xunit;

namespace DshMobile.Win.Tests;

public class DeviceStoreTests
{
    private static SavedDevice Direct(
        byte[] caDer, string instanceId, bool requiresCa, bool platformTrust = false,
        string host = "example.ts.net", int port = 443) => new()
    {
        Channel = "remote",
        EndpointId = instanceId,
        Name = "test",
        Hostname = host,
        Origin = UrlPairing.SerializeOrigin(host, port),
        LocalPort = port,
        InstanceId = instanceId,
        CaDerBase64 = caDer.Length == 0 ? "" : Convert.ToBase64String(caDer),
        RequiresCa = requiresCa,
        PlatformTrust = platformTrust,
    };

    [Fact]
    public void ValidPinnedRemoteDevicePassesValidation()
    {
        var (_, der, id) = TestCertificates.CreateCa();
        var device = Direct(der, id, requiresCa: true);
        device.Validate();
        Assert.True(device.HasPinnedCa);
    }

    [Fact]
    public void RequiresCaDeviceWithoutPinnedCaIsRejected()
    {
        var id = new string('a', 64);
        var device = Direct([], id, requiresCa: true, platformTrust: false);
        Assert.Throws<FormatException>(() => device.Validate());
    }

    [Fact]
    public void PlatformTrustWithRequiresCaIsRejected()
    {
        var id = new string('a', 64);
        var device = Direct([], id, requiresCa: true, platformTrust: true);
        Assert.Throws<FormatException>(() => device.Validate());
    }

    [Fact]
    public void PublicCaRemoteDeviceWithoutPinIsAllowedOnlyWithPlatformTrust()
    {
        var id = new string('a', 64);
        var allowed = Direct([], id, requiresCa: false, platformTrust: true);
        allowed.Validate();
        var rejected = Direct([], id, requiresCa: false, platformTrust: false);
        Assert.Throws<FormatException>(() => rejected.Validate());
    }

    [Fact]
    public void LegacyRecordWithSavedPinIsUpgradedToRequiresCa()
    {
        var (_, der, id) = TestCertificates.CreateCa();
        var device = Direct(der, id, requiresCa: false); // record written before RequiresCa existed
        device.Validate();
        Assert.True(device.RequiresCa);
    }

    [Fact]
    public void TamperedCaFingerprintIsRejected()
    {
        var (_, der, _) = TestCertificates.CreateCa();
        var device = Direct(der, new string('b', 64), requiresCa: true);
        Assert.Throws<FormatException>(() => device.Validate());
    }

    [Fact]
    public void OriginMismatchIsRejected()
    {
        var (_, der, id) = TestCertificates.CreateCa();
        var device = Direct(der, id, requiresCa: true);
        device.Origin = "https://attacker.example:8443";
        Assert.Throws<FormatException>(() => device.Validate());
    }

    [Fact]
    public void BadInstanceIdIsRejected()
    {
        var (_, der, _) = TestCertificates.CreateCa();
        var device = Direct(der, "not-a-hex-id", requiresCa: true);
        Assert.Throws<FormatException>(() => device.Validate());
    }

    [Fact]
    public void AdoptNewOrigin_KeepsName_ReplacesNetworkFields()
    {
        const string instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var old = SavedDevice.FromUrlPairing(UrlPairing.Parse(
            $"https://old.example:3443/mobile-access/pair#instance={instance}&token={new string('A', 43)}"));
        old.Name = "我的电脑";
        old.SetDeviceToken("old-token");
        old.CaDerBase64 = "AA==";

        var adopted = old.AdoptNewOrigin(UrlPairing.Parse(
            $"https://new.example:8443/mobile-access/pair#instance={instance}&token={new string('B', 43)}"));

        Assert.Equal("我的电脑", adopted.Name);
        Assert.Equal("new.example", adopted.Hostname);
        Assert.Equal("https://new.example:8443", adopted.Origin);
        Assert.Equal(8443, adopted.LocalPort);
        Assert.Equal(instance, adopted.InstanceId);
        // The old pin and token must not survive the move.
        Assert.Equal(string.Empty, adopted.CaDerBase64);
        Assert.Equal(string.Empty, adopted.ProtectedDeviceToken);
        Assert.Equal(instance, adopted.EndpointId);
        Assert.Equal(old.PairedAt, adopted.PairedAt);
    }

    [Fact]
    public void AdoptNewOrigin_RejectsDifferentComputer()
    {
        const string instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var old = SavedDevice.FromUrlPairing(UrlPairing.Parse(
            $"https://old.example:3443/mobile-access/pair#instance={instance}&token={new string('A', 43)}"));
        var other = UrlPairing.Parse(
            $"https://new.example:8443/mobile-access/pair#instance={new string('b', 64)}&token={new string('B', 43)}");
        Assert.Throws<FormatException>(() => old.AdoptNewOrigin(other));
    }
}
