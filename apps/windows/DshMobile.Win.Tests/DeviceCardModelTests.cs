using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// The text contract of one device card. These assertions are what the card renderer
/// and the screenshot-level review rely on, and they run without a window.
/// </summary>
public class DeviceCardModelTests
{
    private static readonly DateTimeOffset Now =
        DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000L);

    private static long Ago(TimeSpan elapsed) => Now.ToUnixTimeMilliseconds() - (long)elapsed.TotalMilliseconds;

    private static DeviceCardModel Model(
        DeviceStatusKind status = DeviceStatusKind.Reachable,
        string channel = "局域网",
        long expiresAt = 0,
        long lastConnectedAt = 0,
        bool canReconnect = true) =>
        new(
            EndpointId: "a" + new string('0', 63),
            Name: "书房的电脑",
            ChannelLabel: channel,
            ShortId: "a00000000000",
            Status: status,
            LastConnectedAt: lastConnectedAt,
            ExpiresAt: expiresAt,
            CanReconnect: canReconnect,
            IsCurrent: status == DeviceStatusKind.Current,
            CanMoveUp: true,
            CanMoveToTop: false);

    [Fact]
    public void TheIdentityLineNamesTheModeAndTheShortId()
    {
        var model = Model();
        Assert.Equal("局域网 · a00000000000…", model.IdentityText);
    }

    [Fact]
    public void TheDetailLineAppendsTheCredentialExpiryWhenThereIsOne()
    {
        var expires = Ago(TimeSpan.FromDays(-20));
        var model = Model(expiresAt: expires);
        var expected = "局域网 · a00000000000… · 凭据至 "
            + DateTimeOffset.FromUnixTimeMilliseconds(expires).ToLocalTime().ToString("yyyy-MM-dd");
        Assert.Equal(expected, model.DetailText);
    }

    [Fact]
    public void TheDetailLineOmitsTheExpiryWhenTheRecordHasNone() =>
        // An iroh record with no recorded expiry must not print "凭据至 " with a blank date.
        Assert.Equal("局域网 · a00000000000…", Model(expiresAt: 0).DetailText);

    [Fact]
    public void TheStatusLinePairsTheLabelWithTheLastConnection()
    {
        var model = Model(lastConnectedAt: Ago(TimeSpan.FromMinutes(3)));
        Assert.Equal("可达 · 最近连接 3 分钟前", model.StatusLine(Now));
    }

    [Fact]
    public void ANeverConnectedRecordSaysSoInsteadOfPrintingADate()
    {
        var model = Model(lastConnectedAt: 0);
        Assert.Equal("可达 · 从未连接", model.StatusLine(Now));
    }

    [Fact]
    public void TheStatusLineUsesTheCurrentStateWording()
    {
        var model = Model(status: DeviceStatusKind.Current, lastConnectedAt: Ago(TimeSpan.FromSeconds(5)));
        Assert.Equal("当前连接 · 最近连接 刚刚", model.StatusLine(Now));
    }

    [Fact]
    public void AnIrohRowNeverClaimsUnreachable()
    {
        var model = Model(status: DeviceStatusKind.ConnectToCheck, channel: "iroh");
        Assert.Equal("连接后可检测", model.StatusText);
        Assert.Equal("连接后可检测 · 从未连接", model.StatusLine(Now));
    }

    [Fact]
    public void TheRepairHintAppearsOnlyForAnUnusableCredential()
    {
        Assert.Null(Model(canReconnect: true).RepairHint);
        Assert.Contains("粘贴该电脑当前链接", Model(canReconnect: false).RepairHint);
    }

    [Fact]
    public void TheStatusBrushTokenAlwaysEndsInBrush()
    {
        // The renderer feeds this straight to SetResourceReference; a colour literal or a
        // bare word would not resolve and would silently paint nothing.
        foreach (var kind in Enum.GetValues<DeviceStatusKind>())
        {
            var model = Model(status: kind);
            Assert.EndsWith("Brush", model.StatusBrushToken);
        }
    }
}


