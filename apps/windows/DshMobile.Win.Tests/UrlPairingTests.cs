using Xunit;

namespace DshMobile.Win.Tests;

public class UrlPairingTests
{
    private const string Instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 chars

    private static string Link(string host, string fragment, int port = 443) =>
        $"https://{host}:{port}/mobile-access/pair#{fragment}";

    [Fact]
    public void LegacyFragment_DoesNotRequireCa()
    {
        var link = UrlPairing.Parse(Link("example.ts.net", $"instance={Instance}&token={Token}"));
        Assert.False(link.RequiresCa);
        Assert.Equal(AccessChannel.Remote, link.Mode);
        Assert.True(link.MayUsePlatformTrust);
        Assert.Equal(Instance, link.InstanceId);
        Assert.Equal(Token, link.Token);
    }

    [Fact]
    public void Dsh2Key_RequiresCa()
    {
        var link = UrlPairing.Parse(Link("example.ts.net", $"key=dsh2.{Instance}.{Token}"));
        Assert.True(link.RequiresCa);
        Assert.False(link.MayUsePlatformTrust);
    }

    [Fact]
    public void Dsh1Key_DoesNotRequireCa()
    {
        var link = UrlPairing.Parse(Link("example.ts.net", $"key=dsh1.{Instance}.{Token}"));
        Assert.False(link.RequiresCa);
        Assert.True(link.MayUsePlatformTrust);
    }

    [Fact]
    public void PrivateLanHost_NeverAllowsPlatformTrustFallback()
    {
        var link = UrlPairing.Parse(Link("192.168.1.7", $"instance={Instance}&token={Token}", 8443));
        Assert.Equal(AccessChannel.Lan, link.Mode);
        Assert.False(link.MayUsePlatformTrust);
        Assert.Equal("https://192.168.1.7:8443", link.Origin);
    }

    [Theory]
    [InlineData("http://example.ts.net/mobile-access/pair")]
    [InlineData("https://user@example.ts.net/mobile-access/pair")]
    [InlineData("https://example.ts.net/mobile-access/pair?x=1")]
    [InlineData("https://example.ts.net/other/path")]
    public void RejectsMalformedPairingLinks(string url)
    {
        Assert.Throws<FormatException>(() => UrlPairing.Parse(url + "#" + $"instance={Instance}&token={Token}"));
    }

    [Fact]
    public void RejectsMissingFragment()
    {
        Assert.Throws<FormatException>(() =>
            UrlPairing.Parse("https://example.ts.net/mobile-access/pair"));
    }

    [Fact]
    public void RejectsMalformedFragment()
    {
        Assert.Throws<FormatException>(() =>
            UrlPairing.Parse(Link("example.ts.net", "key=dsh3." + Instance + "." + Token)));
    }

    [Fact]
    public void HostHeaderKeepsDefaultPortImplicit()
    {
        Assert.Equal("example.ts.net", UrlPairing.HostHeader("example.ts.net", 443));
        Assert.Equal("example.ts.net:8443", UrlPairing.HostHeader("example.ts.net", 8443));
        Assert.Equal("[::1]:8443", UrlPairing.HostHeader("::1", 8443));
    }
}
