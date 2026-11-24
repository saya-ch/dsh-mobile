using System.Text.Json;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// Persistence of the device list's manual order. These drive the real
/// <see cref="DeviceStore"/> against a temporary devices.json, because the point is
/// what survives a restart, not what a helper returns.
/// </summary>
public class DeviceStoreOrderingTests : IDisposable
{
    private const string InstanceA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string InstanceB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string InstanceC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    private readonly string _folder = Path.Combine(
        Path.GetTempPath(), "dshm-store-" + Guid.NewGuid().ToString("n"));

    private string StorePath => Path.Combine(_folder, "devices.json");

    public DeviceStoreOrderingTests() => Directory.CreateDirectory(_folder);

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch { /* best effort */ }
    }

    // Validate() requires a pinned CA on every lan/remote record except a public-CA
    // remote key on platform trust, so these fixtures use that shape: the point of the
    // suite is ordering, and a record that fails validation never reaches the list.
    private static SavedDevice Device(string instanceId, long pairedAt = 0) => new()
    {
        Channel = "remote",
        EndpointId = instanceId,
        Name = "电脑 " + instanceId[..6],
        Hostname = "example.ts.net",
        Origin = UrlPairing.SerializeOrigin("example.ts.net", 443),
        LocalPort = 443,
        InstanceId = instanceId,
        PlatformTrust = true,
        PairedAt = pairedAt,
    };

    private static string[] Keys(IEnumerable<SavedDevice> devices) =>
        devices.Select(d => d.EndpointId[..1]).ToArray();

    private DeviceStore NewStore() => new(StorePath, _ => { });

    private void WriteRaw(params SavedDevice[] devices) =>
        File.WriteAllText(StorePath, JsonSerializer.Serialize(devices));

    [Fact]
    public void AStoreWrittenBeforeSortOrderExistedStillLoadsNewestFirst()
    {
        // The upgrade path: no SortOrder property in the file at all.
        WriteRaw(Device(InstanceA, 100), Device(InstanceB, 300), Device(InstanceC, 200));
        Assert.Equal(["b", "c", "a"], Keys(NewStore().All));
    }

    [Fact]
    public void AllDefaultsToZeroSortOrderSoNothingIsRearrangedOnUpgrade()
    {
        WriteRaw(Device(InstanceA, 100), Device(InstanceB, 300));
        var store = NewStore();
        Assert.All(store.All, device => Assert.Equal(0, device.SortOrder));
    }

    [Fact]
    public void MoveUpSurvivesARestart()
    {
        WriteRaw(Device(InstanceA, 300), Device(InstanceB, 200), Device(InstanceC, 100));
        var store = NewStore();
        Assert.Equal(["a", "b", "c"], Keys(store.All));

        Assert.True(store.MoveUp(InstanceC, _ => { }));
        Assert.Equal(["a", "c", "b"], Keys(store.All));

        // The point: a fresh store reading the same file shows the user's arrangement.
        Assert.Equal(["a", "c", "b"], Keys(NewStore().All));
    }

    [Fact]
    public void MoveToTopSurvivesARestart()
    {
        WriteRaw(Device(InstanceA, 300), Device(InstanceB, 200), Device(InstanceC, 100));
        var store = NewStore();
        Assert.True(store.MoveToTop(InstanceC, _ => { }));
        Assert.Equal(["c", "a", "b"], Keys(store.All));
        Assert.Equal(["c", "a", "b"], Keys(NewStore().All));
    }

    [Fact]
    public void MovingTheFirstRowReportsNoChangeAndDoesNotRewriteTheFile()
    {
        WriteRaw(Device(InstanceA, 300), Device(InstanceB, 200));
        var store = NewStore();
        var before = File.ReadAllText(StorePath);
        var stamp = File.GetLastWriteTimeUtc(StorePath);

        Assert.False(store.MoveUp(InstanceA, _ => { }));
        Assert.False(store.MoveToTop(InstanceA, _ => { }));

        Assert.Equal(before, File.ReadAllText(StorePath));
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(StorePath));
    }

    [Fact]
    public void MovingAnUnknownRecordIsANoOp() =>
        Assert.False(NewStore().MoveUp(InstanceA, _ => { }));

    [Fact]
    public void ArrangedOrderBeatsPairingTimeAfterReload()
    {
        // Arrange B above A even though A was paired later.
        WriteRaw(Device(InstanceA, 300), Device(InstanceB, 100));
        NewStore().MoveToTop(InstanceB, _ => { });

        var reloaded = NewStore().All;
        Assert.Equal(["b", "a"], Keys(reloaded));
        Assert.Equal(1, reloaded[0].SortOrder);
        Assert.Equal(2, reloaded[1].SortOrder);
    }

    [Fact]
    public void UpsertingAnExistingRecordKeepsItsSortOrderAndLastConnectedTime()
    {
        // A renewal rewrites the record; losing the arrangement or the "last connected"
        // line on every reconnect would undo the user's work.
        WriteRaw(Device(InstanceA, 300), Device(InstanceB, 100));
        var store = NewStore();
        store.MoveToTop(InstanceB, _ => { });
        store.MarkConnected(InstanceB, 1_700_000_000_000L, _ => { });

        var renewed = Device(InstanceB, 100);
        renewed.DeviceId = "device-id";
        renewed.ProtectedDeviceToken = "sealed";
        renewed.DeviceExpiresAt = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeMilliseconds();
        store.Upsert(renewed, _ => { });

        var reloaded = NewStore().All;
        Assert.Equal(["b", "a"], Keys(reloaded));
        Assert.Equal(1, reloaded[0].SortOrder);
        Assert.Equal(1_700_000_000_000L, reloaded[0].LastConnectedAt);
    }

    [Fact]
    public void ANewlyPairedRecordAppendsInsteadOfJumpingToTheTop()
    {
        WriteRaw(Device(InstanceA, 300), Device(InstanceB, 200));
        var store = NewStore();
        store.MoveToTop(InstanceB, _ => { });
        Assert.Equal(["b", "a"], Keys(store.All));

        var added = Device(InstanceC, 400); // newest paired, must still append
        added.DeviceId = "device-id";
        added.ProtectedDeviceToken = "sealed";
        added.DeviceExpiresAt = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeMilliseconds();
        store.Upsert(added, _ => { });

        Assert.Equal(["b", "a", "c"], Keys(NewStore().All));
    }

    [Fact]
    public void MarkConnectedKeepsTheNewestTimestampOnly()
    {
        WriteRaw(Device(InstanceA, 300));
        var store = NewStore();
        store.MarkConnected(InstanceA, 2_000L, _ => { });
        store.MarkConnected(InstanceA, 1_000L, _ => { }); // late writer, older stamp
        Assert.Equal(2_000L, NewStore().All[0].LastConnectedAt);
    }

    [Fact]
    public void MarkConnectedIgnoresAnUnknownRecord() =>
        NewStore().MarkConnected(InstanceA, 2_000L, _ => { });

    // ---- Delete + undo -------------------------------------------------------------

    [Fact]
    public void RestorePutsTheRecordBackWhereItWas()
    {
        // The undo path: delete then restore must land the row in its old position and
        // keep its name, not append it or renumber the rest.
        WriteRaw(Device(InstanceA, 300), Device(InstanceB, 200), Device(InstanceC, 100));
        var store = NewStore();
        store.MoveToTop(InstanceC, _ => { });
        var ordered = store.All;
        Assert.Equal(["c", "a", "b"], Keys(ordered));

        var removed = ordered[1]; // the middle row
        store.Remove(removed.EndpointId, _ => { });
        Assert.Equal(["c", "b"], Keys(store.All));

        store.Restore(removed, _ => { });
        Assert.Equal(["c", "a", "b"], Keys(NewStore().All));
        Assert.Equal("电脑 aaaaaa", NewStore().All[1].Name);
    }

    [Fact]
    public void RestoredRecordSurvivesARestartWithItsLastConnectedTime()
    {
        WriteRaw(Device(InstanceA, 300));
        var store = NewStore();
        store.MarkConnected(InstanceA, 1_700_000_000_000L, _ => { });
        var removed = store.All[0];

        store.Remove(InstanceA, _ => { });
        store.Restore(removed, _ => { });

        var reloaded = NewStore().All;
        Assert.Single(reloaded);
        Assert.Equal(1_700_000_000_000L, reloaded[0].LastConnectedAt);
    }

    [Fact]
    public void RestoringAnAlreadyPresentRecordChangesNothing()
    {
        WriteRaw(Device(InstanceA, 300));
        var store = NewStore();
        var duplicate = Device(InstanceA, 300);

        store.Restore(duplicate, _ => { });

        Assert.Single(store.All);
    }
}
