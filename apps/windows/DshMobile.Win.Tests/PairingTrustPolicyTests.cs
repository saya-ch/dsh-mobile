using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// The 404 decision must mirror Android's PairingTrust.selectTrustAnchor +
/// RemotePairingTrust.decide. These are the regression tests for the dsh2
/// silent-downgrade issue raised in PR review: a dsh2 key must never fall back
/// to the platform trust store.
/// </summary>
public class PairingTrustPolicyTests
{
    private static SavedDevice Device(
        string channel, bool requiresCa, bool pinnedCa = false, bool platformTrust = false)
    {
        var id = new string('a', 64);
        return new SavedDevice
        {
            Channel = channel,
            EndpointId = id,
            InstanceId = id,
            Hostname = "example.ts.net",
            Origin = "https://example.ts.net",
            LocalPort = 443,
            CaDerBase64 = pinnedCa ? Convert.ToBase64String(TestCertificates.CreateCa().Der) : "",
            RequiresCa = requiresCa,
            PlatformTrust = platformTrust,
        };
    }

    [Fact]
    public void Dsh2Remote404_IsHardFailure()
    {
        Assert.Equal(CaBootstrapOutcome.Reject,
            PairingTrustPolicy.Decide(404, Device("remote", requiresCa: true)));
    }

    [Fact]
    public void Dsh1Remote404_AllowsPlatformTrust()
    {
        Assert.Equal(CaBootstrapOutcome.PlatformTrust,
            PairingTrustPolicy.Decide(404, Device("remote", requiresCa: false)));
    }

    [Fact]
    public void LegacyRemote404_AllowsPlatformTrust()
    {
        var link = UrlPairing.Parse(
            "https://example.ts.net/mobile-access/pair#instance=" + new string('a', 64) +
            "&token=" + new string('A', 43));
        var device = SavedDevice.FromUrlPairing(link);
        Assert.False(device.RequiresCa);
        Assert.Equal(CaBootstrapOutcome.PlatformTrust, PairingTrustPolicy.Decide(404, device));
    }

    [Fact]
    public void Lan404_IsHardFailure()
    {
        Assert.Equal(CaBootstrapOutcome.Reject,
            PairingTrustPolicy.Decide(404, Device("lan", requiresCa: false)));
    }

    [Fact]
    public void AlreadyPinnedDevice404_IsNeverDowngraded()
    {
        Assert.Equal(CaBootstrapOutcome.Reject,
            PairingTrustPolicy.Decide(404, Device("remote", requiresCa: false, pinnedCa: true)));
    }

    [Theory]
    [InlineData(200, "PinnedCa")]
    [InlineData(201, "PinnedCa")]
    [InlineData(403, "Reject")]
    [InlineData(500, "Reject")]
    public void Non404StatusesBehaveDeterministically(int status, string expected)
    {
        Assert.Equal(expected,
            PairingTrustPolicy.Decide(status, Device("remote", requiresCa: false)).ToString());
    }
}
