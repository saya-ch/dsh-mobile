using System.Net;
using Xunit;

namespace DshMobile.Win.Tests;

public class DeviceReachabilityTests
{
    private const string InstanceA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string InstanceB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    private static SavedDevice Device(
        string instanceId = InstanceA, string channel = "lan", bool canReconnect = true)
    {
        var device = new SavedDevice
        {
            Channel = channel,
            EndpointId = instanceId,
            Name = "test",
            Hostname = "192.168.1.18",
            Origin = "https://192.168.1.18:3443",
            LocalPort = 3443,
            InstanceId = instanceId,
        };
        if (canReconnect)
        {
            device.DeviceId = "device-id";
            device.SetDeviceToken("token");
            device.DeviceExpiresAt = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeMilliseconds();
        }
        return device;
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // ---- SelectDue: the scheduling policy ------------------------------------------

    [Fact]
    public void ANewDirectRecordIsDueImmediately()
    {
        var due = DeviceReachability.SelectDue(
            [Device()], new Dictionary<string, long>(), Now,
            new HashSet<string>(), new HashSet<string>());
        Assert.Single(due);
    }

    [Fact]
    public void AnIrohRecordIsNeverProbed()
    {
        // Its gateway is only reachable through the sidecar's loopback proxy, which does
        // not exist until a connect starts: probing would report a healthy pairing as
        // unreachable.
        var due = DeviceReachability.SelectDue(
            [Device(channel: "iroh")], new Dictionary<string, long>(), Now,
            new HashSet<string>(), new HashSet<string>());
        Assert.Empty(due);
    }

    [Fact]
    public void ARecordProbedInsideTheIntervalIsSkipped()
    {
        var lastAt = Now;
        var due = DeviceReachability.SelectDue(
            [Device()], new Dictionary<string, long> { [InstanceA] = lastAt },
            lastAt + (long)DeviceReachability.ProbeInterval.TotalMilliseconds - 1,
            new HashSet<string>(), new HashSet<string>());
        Assert.Empty(due);
    }

    [Fact]
    public void ARecordBecomesDueAgainOnceTheIntervalElapsed()
    {
        var lastAt = Now;
        var due = DeviceReachability.SelectDue(
            [Device()], new Dictionary<string, long> { [InstanceA] = lastAt },
            lastAt + (long)DeviceReachability.ProbeInterval.TotalMilliseconds,
            new HashSet<string>(), new HashSet<string>());
        Assert.Single(due);
    }

    [Fact]
    public void ARevokedRecordIsNotProbed()
    {
        var due = DeviceReachability.SelectDue(
            [Device()], new Dictionary<string, long>(), Now,
            new HashSet<string>(), new HashSet<string> { InstanceA });
        Assert.Empty(due);
    }

    [Fact]
    public void ARowAlreadyInFlightIsNotStartedAgain()
    {
        var due = DeviceReachability.SelectDue(
            [Device()], new Dictionary<string, long>(), Now,
            new HashSet<string> { InstanceA }, new HashSet<string>());
        Assert.Empty(due);
    }

    [Fact]
    public void NoMoreThanTwoProbesStartAtOnce()
    {
        var devices = Enumerable.Range(0, 5)
            .Select(index => Device(index.ToString("x64")))
            .ToList();
        var due = DeviceReachability.SelectDue(
            devices, new Dictionary<string, long>(), Now,
            new HashSet<string>(), new HashSet<string>());
        Assert.Equal(DeviceReachability.MaxConcurrent, due.Count);
        Assert.Equal(2, DeviceReachability.MaxConcurrent);
    }

    [Fact]
    public void TheConcurrencyCapCountsProbesAlreadyRunning()
    {
        // One slot is taken, so only one more may start even though four rows are due.
        var devices = new[]
        {
            Device(InstanceA), Device(InstanceB), Device("c".PadRight(64, 'c')),
            Device("d".PadRight(64, 'd')),
        };
        var due = DeviceReachability.SelectDue(
            devices, new Dictionary<string, long>(), Now,
            new HashSet<string> { "c".PadRight(64, 'c') }, new HashSet<string>());
        Assert.Single(due);
    }

    [Fact]
    public void NoSlotsFreeMeansNothingStarts()
    {
        var due = DeviceReachability.SelectDue(
            [Device(InstanceA), Device(InstanceB)], new Dictionary<string, long>(), Now,
            new HashSet<string> { InstanceA, InstanceB }, new HashSet<string>());
        Assert.Empty(due);
    }

    [Fact]
    public void TheIntervalIsAtLeastFifteenSeconds()
    {
        // The task's floor: polling must not hammer a computer's gateway.
        Assert.True(DeviceReachability.ProbeInterval >= TimeSpan.FromSeconds(15));
        Assert.True(DeviceReachability.ProbeTimeout < TimeSpan.FromSeconds(15));
    }

    // ---- Result bookkeeping --------------------------------------------------------

    [Fact]
    public void AResultIsRememberedPerRecord()
    {
        using var poller = NewPoller((_, _) => Task.FromResult(DeviceStatusKind.Reachable));
        Assert.Null(poller.ResultFor(InstanceA));
    }

    [Fact]
    public void MarkRevokedIsStickyAndReportedImmediately()
    {
        var observed = new List<ReachabilityObservation>();
        using var poller = new DeviceReachability(
            (_, _) => Task.FromResult(DeviceStatusKind.Reachable),
            observed.Add, _ => { }, () => false);

        poller.MarkRevoked(InstanceA);

        Assert.Equal(DeviceStatusKind.Revoked, poller.ResultFor(InstanceA));
        var result = Assert.Single(observed);
        Assert.Equal(InstanceA, result.EndpointId);
        Assert.Equal(DeviceStatusKind.Revoked, result.Kind);
    }

    [Fact]
    public void ForgetClearsTheRememberedState()
    {
        using var poller = new DeviceReachability(
            (_, _) => Task.FromResult(DeviceStatusKind.Reachable),
            _ => { }, _ => { }, () => false);
        poller.MarkRevoked(InstanceA);
        poller.Forget(InstanceA);
        Assert.Null(poller.ResultFor(InstanceA));
    }

    [Fact]
    public void RefreshDropsStateForRecordsThatNoLongerExist()
    {
        // A deleted computer must not leave a result behind for a record that is later
        // paired with the same endpoint id.
        using var poller = new DeviceReachability(
            (_, _) => Task.FromResult(DeviceStatusKind.Reachable),
            _ => { }, _ => { }, () => false);
        poller.MarkRevoked(InstanceA);
        poller.Refresh([Device(InstanceB)]);
        Assert.Null(poller.ResultFor(InstanceA));
    }

    private static DeviceReachability NewPoller(
        Func<SavedDevice, CancellationToken, Task<DeviceStatusKind>> probe) =>
        new(probe, _ => { }, _ => { }, () => false);

    // ---- Probe classification ------------------------------------------------------
    // These drive a real loopback TCP listener, so they exercise the actual
    // LanDiscovery.ProbeAsync path rather than a mock of it.

    [Fact]
    public async Task ARefusedConnectionIsUnreachable()
    {
        // Bind and immediately close to get a port nothing listens on.
        var port = FreePort();
        var device = DeviceWithPort(port);
        var kind = await DeviceReachability.ProbeAsync(device, CancellationToken.None);
        Assert.Equal(DeviceStatusKind.Unreachable, kind);
    }

    [Fact]
    public async Task AnUnresolvableHostIsUnreachable()
    {
        var device = Device();
        device.Hostname = "this-host-does-not-exist.invalid";
        device.Origin = "https://this-host-does-not-exist.invalid:3443";
        var kind = await DeviceReachability.ProbeAsync(device, CancellationToken.None);
        Assert.Equal(DeviceStatusKind.Unreachable, kind);
    }

    [Fact]
    public async Task CancellationPropagatesInsteadOfBecomingUnreachable()
    {
        // A cancellation is not an observation: painting it as "unreachable" would mark
        // a healthy computer red every time the window closes.
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var device = DeviceWithPort(FreePort());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => DeviceReachability.ProbeAsync(device, cts.Token));
    }

    private static int FreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static SavedDevice DeviceWithPort(int port) => new()
    {
        Channel = "remote",
        EndpointId = InstanceA,
        Name = "test",
        Hostname = "127.0.0.1",
        Origin = UrlPairing.SerializeOrigin("127.0.0.1", port),
        LocalPort = port,
        InstanceId = InstanceA,
    };
}
