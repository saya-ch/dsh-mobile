using Xunit;

namespace DshMobile.Win.Tests;

public class DeviceStatusTests
{
    private const string Instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private static SavedDevice Device(
        string channel = "lan", bool canReconnect = true, string? instanceId = null)
    {
        var device = new SavedDevice
        {
            Channel = channel,
            EndpointId = instanceId ?? Instance,
            Name = "test",
            Hostname = "192.168.1.18",
            Origin = "https://192.168.1.18:3443",
            LocalPort = 3443,
            InstanceId = instanceId ?? Instance,
        };
        if (canReconnect)
        {
            device.DeviceId = "device-id";
            device.SetDeviceToken("token");
            device.DeviceExpiresAt = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeMilliseconds();
        }
        return device;
    }

    [Fact]
    public void EveryKindHasTextAndABrushToken()
    {
        foreach (var kind in Enum.GetValues<DeviceStatusKind>())
        {
            Assert.False(string.IsNullOrWhiteSpace(DeviceStatus.Text(kind)), kind + " has no text");
            Assert.False(string.IsNullOrWhiteSpace(DeviceStatus.BrushToken(kind)), kind + " has no brush");
        }
    }

    [Fact]
    public void EveryBrushTokenIsASemanticTokenNotAColour()
    {
        // The card renderer looks these up as DynamicResource keys; a literal colour
        // here would silently ignore the dark palette.
        foreach (var kind in Enum.GetValues<DeviceStatusKind>())
        {
            var token = DeviceStatus.BrushToken(kind);
            Assert.EndsWith("Brush", token);
            Assert.DoesNotContain("#", token);
        }
    }

    [Fact]
    public void TheSevenMobileStatesAreAllReachable()
    {
        // The phone shows these seven (MainActivity.setDeviceStatusText); the desktop
        // list must be able to show every one of them.
        DeviceStatusKind[] mobile =
        [
            DeviceStatusKind.Current,
            DeviceStatusKind.Reachable,
            DeviceStatusKind.Checking,
            DeviceStatusKind.Unreachable,
            DeviceStatusKind.Revoked,
            DeviceStatusKind.Expired,
            DeviceStatusKind.AddressChanged,
        ];
        Assert.All(mobile, kind => Assert.False(string.IsNullOrWhiteSpace(DeviceStatus.Text(kind))));
        Assert.Equal(8, Enum.GetValues<DeviceStatusKind>().Length); // + ConnectToCheck
    }

    [Fact]
    public void ALiveSessionBeatsEveryOtherState()
    {
        // Direct evidence outranks a stale probe: the window is talking to it now.
        var device = Device();
        Assert.Equal(DeviceStatusKind.Current,
            DeviceStatus.Resolve(device, Instance, DeviceStatusKind.Unreachable));
        Assert.Equal(DeviceStatusKind.Current,
            DeviceStatus.Resolve(device, Instance, DeviceStatusKind.Revoked));
        Assert.Equal(DeviceStatusKind.Current, DeviceStatus.Resolve(device, Instance, null));
    }

    [Fact]
    public void ARevocationSurvivesALaterSuccessfulProbe()
    {
        // Discovery is unauthenticated: it cannot observe a revocation, so a probe
        // saying "reachable" must not erase what a failed connect already learned.
        var device = Device();
        Assert.Equal(DeviceStatusKind.Revoked,
            DeviceStatus.Resolve(device, null, DeviceStatusKind.Revoked));
    }

    [Fact]
    public void AnExpiredCredentialOutranksAReachableProbe()
    {
        // The computer may be up, but this record still cannot connect.
        var device = Device(canReconnect: false);
        Assert.Equal(DeviceStatusKind.Expired,
            DeviceStatus.Resolve(device, null, DeviceStatusKind.Reachable));
    }

    [Theory]
    [InlineData(nameof(DeviceStatusKind.Reachable))]
    [InlineData(nameof(DeviceStatusKind.Unreachable))]
    [InlineData(nameof(DeviceStatusKind.AddressChanged))]
    [InlineData(nameof(DeviceStatusKind.Checking))]
    public void AProbeResultIsShownWhenNothingOutranksIt(string kind)
    {
        // The enum is internal, so xUnit attributes cannot carry it directly; the name
        // round-trips and fails loudly if a member is renamed.
        var probe = Enum.Parse<DeviceStatusKind>(kind);
        Assert.Equal(probe, DeviceStatus.Resolve(Device(), null, probe));
    }

    [Fact]
    public void AnIrohRowIsNotCalledUnreachableBeforeItsTunnelExists()
    {
        // The sidecar's loopback proxy only exists once a connect starts, so an
        // unprobed iroh row must not read as a failure.
        Assert.Equal(DeviceStatusKind.ConnectToCheck,
            DeviceStatus.Resolve(Device(channel: "iroh"), null, null));
    }

    [Fact]
    public void ADirectRowWithoutAProbeIsChecking() =>
        Assert.Equal(DeviceStatusKind.Checking, DeviceStatus.Resolve(Device(), null, null));

    [Theory]
    [InlineData(nameof(DeviceStatusKind.Revoked), false)]
    [InlineData(nameof(DeviceStatusKind.Expired), false)]
    [InlineData(nameof(DeviceStatusKind.Current), true)]
    [InlineData(nameof(DeviceStatusKind.Reachable), true)]
    [InlineData(nameof(DeviceStatusKind.Unreachable), true)]
    [InlineData(nameof(DeviceStatusKind.Checking), true)]
    [InlineData(nameof(DeviceStatusKind.ConnectToCheck), true)]
    public void OnlyRevokedAndExpiredBlockConnecting(string kind, bool canConnect)
    {
        // "Unreachable" is a hint, not a gate: the probe may be stale or the network
        // may have just come back, so the button stays available and the connect
        // attempt is the authority.
        Assert.Equal(canConnect, DeviceStatus.CanConnect(Enum.Parse<DeviceStatusKind>(kind)));
    }
}
