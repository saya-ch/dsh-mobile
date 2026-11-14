using System.Net;
using Xunit;

namespace DshMobile.Win.Tests;

public class LanDiscoveryTests
{
    private const string Instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private static string Announcement(
        string deviceName = "dev",
        string origin = "https://192.168.1.18:3443",
        int port = 3443,
        int protocol = 1,
        string? instanceId = Instance,
        string extra = "") =>
        $"{{\"deviceName\":{Json(deviceName)},\"origin\":{Json(origin)}," +
        $"\"port\":{port},\"protocol\":{protocol},\"instanceId\":{Json(instanceId)}{extra}}}";

    private static string Json(string? value) =>
        value is null ? "null" : $"\"{value}\"";

    [Fact]
    public void AcceptsValidAnnouncement()
    {
        var gateway = LanDiscovery.TryParseAnnouncement(
            Announcement(), "192.168.1.18", out var reason);
        Assert.NotNull(gateway);
        Assert.Equal(string.Empty, reason);
        Assert.Equal("dev", gateway.DeviceName);
        Assert.Equal("192.168.1.18", gateway.Hostname);
        Assert.Equal(3443, gateway.Port);
        Assert.Equal("https://192.168.1.18:3443", gateway.Origin);
        Assert.Equal(Instance, gateway.InstanceId);
    }

    [Theory]
    [InlineData(2)]    // wrong protocol
    [InlineData(0)]
    public void RejectsWrongProtocol(int protocol)
    {
        Assert.Null(LanDiscovery.TryParseAnnouncement(
            Announcement(protocol: protocol), "192.168.1.18", out _));
    }

    [Theory]
    [InlineData("short")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")] // not hex
    public void RejectsBadInstanceId(string instanceId)
    {
        Assert.Null(LanDiscovery.TryParseAnnouncement(
            Announcement(instanceId: instanceId), "192.168.1.18", out _));
    }

    [Fact]
    public void RejectsOriginSpoof_FromAnotherAddress()
    {
        // The origin must be the address that actually sent the announcement.
        Assert.Null(LanDiscovery.TryParseAnnouncement(
            Announcement(), "192.168.1.99", out var reason));
        Assert.Contains("sender", reason);
    }

    [Fact]
    public void RejectsOriginPortMismatch()
    {
        Assert.Null(LanDiscovery.TryParseAnnouncement(
            Announcement(origin: "https://192.168.1.18:9999", port: 3443),
            "192.168.1.18", out _));
    }

    [Theory]
    [InlineData("\"token\":\"abc\"")]
    [InlineData("\"deviceToken\":\"abc\"")]
    [InlineData("\"secret\":\"abc\"")]
    [InlineData("\"gatewayToken\":\"abc\"")]
    public void RejectsSecretFields(string extraField)
    {
        Assert.Null(LanDiscovery.TryParseAnnouncement(
            Announcement(extra: "," + extraField), "192.168.1.18", out var reason));
        Assert.Contains("secret", reason);
    }

    [Theory]
    [InlineData("")]
    [InlineData("this-device-name-is-way-too-long-for-the-sixty-three-char-limit-x")]
    public void RejectsBadDeviceName(string deviceName)
    {
        Assert.Null(LanDiscovery.TryParseAnnouncement(
            Announcement(deviceName: deviceName), "192.168.1.18", out _));
    }

    [Fact]
    public void RejectsNonHttpsOrigin()
    {
        Assert.Null(LanDiscovery.TryParseAnnouncement(
            Announcement(origin: "http://192.168.1.18:3443"), "192.168.1.18", out _));
    }

    [Fact]
    public void RejectsNonJson()
    {
        Assert.Null(LanDiscovery.TryParseAnnouncement("not json", "192.168.1.18", out _));
    }

    [Theory]
    [InlineData("192.168.1.18", "192.168.1.18", 3443)]
    [InlineData("192.168.1.18:8443", "192.168.1.18", 8443)]
    [InlineData("https://192.168.1.18", "192.168.1.18", 3443)]
    [InlineData("https://192.168.1.18:8443/", "192.168.1.18", 8443)]
    [InlineData("https://192.168.1.18:8443/mobile-access/pair", "192.168.1.18", 8443)]
    [InlineData("  192.168.1.18  ", "192.168.1.18", 3443)]
    [InlineData("my-pc.local", "my-pc.local", 3443)]
    public void AcceptsManualInputs(string input, string host, int port)
    {
        Assert.Equal((host, port), LanDiscovery.NormalizeManualInput(input));
    }

    [Theory]
    [InlineData("http://192.168.1.18")]
    [InlineData("https://user@192.168.1.18")]
    [InlineData("https://192.168.1.18/?x=1")]
    [InlineData("https://192.168.1.18/#instance=abc")]
    [InlineData("https://192.168.1.18:99999")]
    [InlineData("")]
    [InlineData("not a host!!")]
    public void RejectsManualInputs(string input)
    {
        Assert.Throws<FormatException>(() => LanDiscovery.NormalizeManualInput(input));
    }

    [Fact]
    public async Task Probe_RefusedPort_ThrowsCleanly()
    {
        // Nothing listens on 127.0.0.1:9 (discard); the probe must fail fast
        // with a connection error, not hang or return a gateway.
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            LanDiscovery.ProbeAsync("127.0.0.1", 9, cts.Token));
    }

    [Fact]
    public void BroadcastFor_ComputesSubnetBroadcast()
    {
        Assert.Equal(
            IPAddress.Parse("192.168.1.255"),
            LanDiscovery.BroadcastFor(
                IPAddress.Parse("192.168.1.18"),
                IPAddress.Parse("255.255.255.0")));
        Assert.Equal(
            IPAddress.Parse("10.0.0.255"),
            LanDiscovery.BroadcastFor(
                IPAddress.Parse("10.0.0.5"),
                IPAddress.Parse("255.255.255.0")));
    }

    [Fact]
    public void SubnetHosts_CoversSlash24ExceptSelfAndEdges()
    {
        var hosts = LanDiscovery.SubnetHosts("192.168.1.18");
        Assert.Equal(253, hosts.Count);
        Assert.Contains("192.168.1.1", hosts);
        Assert.Contains("192.168.1.254", hosts);
        Assert.DoesNotContain("192.168.1.0", hosts);
        Assert.DoesNotContain("192.168.1.255", hosts);
        Assert.DoesNotContain("192.168.1.18", hosts);
    }

    [Fact]
    public void SubnetHosts_RejectsLoopback()
    {
        Assert.Empty(LanDiscovery.SubnetHosts("127.0.0.1"));
    }

    [Fact]
    public async Task QueryAsync_HearsUnsolicitedAnnouncement()
    {
        // The plugin broadcasts announcements every 3s, so a listener must
        // accept them without having sent a query first.
        const int port = 44944;
        var announcement = Announcement(origin: $"https://127.0.0.1:{port}", port: port);
        using var sender = new System.Net.Sockets.UdpClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var endpoint = new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, port);
        var bytes = System.Text.Encoding.UTF8.GetBytes(announcement);
        var sendLoop = Task.Run(async () =>
        {
            while (!cts.Token.IsCancellationRequested)
            {
                try { await sender.SendAsync(bytes, endpoint, cts.Token); }
                catch { break; }
                await Task.Delay(300, cts.Token).ContinueWith(_ => { });
            }
        });
        try
        {
            await foreach (var gateway in LanDiscovery.QueryAsync(
                port, TimeSpan.FromSeconds(8), _ => { }, cts.Token,
                targets: new[] { System.Net.IPAddress.Loopback }))
            {
                Assert.Equal("127.0.0.1", gateway.Hostname);
                Assert.Equal(port, gateway.Port);
                return;
            }
            Assert.Fail("no announcement heard");
        }
        finally
        {
            cts.Cancel();
            await sendLoop;
        }
    }
}
