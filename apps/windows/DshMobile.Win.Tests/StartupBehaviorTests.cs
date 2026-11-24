using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// Launch behaviour: "显示设备列表" vs "自动连接上次的电脑".
/// </summary>
public class StartupBehaviorTests
{
    private static SavedDevice Device(string endpointId, string name = "电脑")
    {
        // CanAutoConnect needs a readable device token, so every fixture seals one.
        var device = new SavedDevice
        {
            EndpointId = endpointId,
            Channel = "lan",
            Name = name,
            Hostname = "192.168.1.18",
            Origin = "https://192.168.1.18:3443",
            LocalPort = 3443,
            InstanceId = endpointId,
            DeviceId = "device-" + endpointId,
            DeviceExpiresAt = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeMilliseconds(),
            PairedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        device.SetDeviceToken("token-" + endpointId);
        return device;
    }

    private static SavedDevice ExpiredDevice(string endpointId)
    {
        var device = Device(endpointId);
        device.DeviceExpiresAt = DateTimeOffset.UtcNow.AddDays(-1).ToUnixTimeMilliseconds();
        return device;
    }

    [Theory]
    [InlineData(AppSettings.StartPageDevices, false)]
    [InlineData(AppSettings.StartPageLastDevice, true)]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("nonsense", false)]
    public void OnlyTheLastDeviceSettingAutoConnects(string? startPage, bool expected)
    {
        Assert.Equal(expected, StartupBehavior.WantsAutoConnect(startPage));
    }

    [Fact]
    public void DeviceListSettingNeverAutoConnects()
    {
        var devices = new List<SavedDevice> { Device("a"), Device("b") };
        Assert.Null(StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageDevices, devices, "a"));
    }

    [Fact]
    public void EmptyDeviceListNeverAutoConnects()
    {
        Assert.Null(StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [], null));
    }

    [Fact]
    public void PrefersTheLastConnectedComputer()
    {
        var first = Device("first");
        var second = Device("second");
        var target = StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [first, second], "second");
        Assert.Same(second, target);
    }

    [Fact]
    public void FallsBackToTheMostRecentlyPairedComputerWhenNothingWasRecorded()
    {
        // The list arrives most-recent-first; a fresh install has no LastDeviceEndpointId.
        var newest = Device("newest");
        var older = Device("older");
        var target = StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [newest, older], null);
        Assert.Same(newest, target);
    }

    [Fact]
    public void FallsBackWhenTheRecordedComputerIsGone()
    {
        var remaining = Device("remaining");
        var target = StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [remaining], "deleted-endpoint");
        Assert.Same(remaining, target);
    }

    [Fact]
    public void NeverAutoConnectsAnExpiredCredential()
    {
        // Auto-connecting this would raise a failure dialog on every launch.
        var expired = ExpiredDevice("expired");
        Assert.Null(StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [expired], "expired"));
    }

    [Fact]
    public void SkipsAnExpiredLastDeviceAndUsesAUsableOne()
    {
        var expired = ExpiredDevice("expired");
        var usable = Device("usable");
        var target = StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [expired, usable], "expired");
        Assert.Same(usable, target);
    }

    [Fact]
    public void SkipsADeviceWhoseTokenCannotBeRead()
    {
        var broken = Device("broken");
        broken.ProtectedDeviceToken = "not-a-dpapi-blob";
        var usable = Device("usable");
        var target = StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [broken, usable], "broken");
        Assert.Same(usable, target);
    }

    [Fact]
    public void CanAutoConnectRequiresBothACredentialAndTimeLeft()
    {
        Assert.True(StartupBehavior.CanAutoConnect(Device("ok")));
        Assert.False(StartupBehavior.CanAutoConnect(ExpiredDevice("old")));
    }

    [Fact]
    public void AnInjectedProbeReplacesTheDefaultUsabilityRule()
    {
        var blocked = Device("blocked");
        Assert.Null(StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [blocked], "blocked", _ => false));
        Assert.Same(blocked, StartupBehavior.SelectAutoConnectTarget(
            AppSettings.StartPageLastDevice, [blocked], "blocked", _ => true));
    }

    [Fact]
    public void AutoConnectFailureSaysWhyTheDeviceListAppeared()
    {
        var text = StartupBehavior.DescribeAutoConnectFailure("无法连接", "我的电脑");
        Assert.Contains("启动时自动连接", text);
        Assert.Contains("我的电脑", text);
        Assert.Contains("无法连接", text);
        Assert.Contains("已返回设备列表", text);
    }

    // ---- recording the last computer ----

    [Fact]
    public void RecordsTheLastComputerOnceAndPersistsIt()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-settings-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            var settings = new AppSettings();
            var device = Device("target-endpoint");

            Assert.True(StartupBehavior.RememberLastDevice(settings, root, device));
            Assert.Equal("target-endpoint", settings.LastDeviceEndpointId);

            // The stored file must carry it, so the next launch can read it back.
            var reloaded = AppSettings.Load(root);
            Assert.Equal("target-endpoint", reloaded.LastDeviceEndpointId);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void DoesNotRewriteSettingsWhenNothingChanged()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-settings-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            var settings = new AppSettings();
            var device = Device("same-endpoint");
            Assert.True(StartupBehavior.RememberLastDevice(settings, root, device));
            // A reconnect loop must not rewrite settings.json every time.
            Assert.False(StartupBehavior.RememberLastDevice(settings, root, device));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void AReadOnlyFolderDoesNotThrow()
    {
        // AppSettings.Save swallows write failures; the in-memory value still updates.
        var missing = Path.Combine(Path.GetTempPath(), "dsh-win-missing-" + Guid.NewGuid().ToString("N"));
        var settings = new AppSettings();
        Assert.True(StartupBehavior.RememberLastDevice(settings, missing, Device("ep")));
        Assert.Equal("ep", settings.LastDeviceEndpointId);
    }
}
