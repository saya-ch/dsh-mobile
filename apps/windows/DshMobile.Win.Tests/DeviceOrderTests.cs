using Xunit;

namespace DshMobile.Win.Tests;

public class DeviceOrderTests
{
    private const string InstanceA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string InstanceB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string InstanceC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    private static SavedDevice Device(string instanceId, int sortOrder = 0, long pairedAt = 0) => new()
    {
        Channel = "lan",
        EndpointId = instanceId,
        Name = instanceId[..6],
        Hostname = "192.168.1.18",
        Origin = "https://192.168.1.18:3443",
        LocalPort = 3443,
        InstanceId = instanceId,
        SortOrder = sortOrder,
        PairedAt = pairedAt,
    };

    private static string[] Keys(IEnumerable<SavedDevice> devices) =>
        devices.Select(d => d.EndpointId[..1]).ToArray();

    [Fact]
    public void AnUnarrangedStoreKeepsThePreviousNewestFirstOrder()
    {
        // Every record written before SortOrder existed reads 0. The list must look
        // exactly as it did before the upgrade, so no migration write is needed.
        var devices = new[]
        {
            Device(InstanceA, pairedAt: 100),
            Device(InstanceB, pairedAt: 300),
            Device(InstanceC, pairedAt: 200),
        };
        Assert.Equal(["b", "c", "a"], Keys(DeviceOrder.Order(devices)));
    }

    [Fact]
    public void SortOrderBeatsPairingTime()
    {
        var devices = new[]
        {
            Device(InstanceA, sortOrder: 3, pairedAt: 300),
            Device(InstanceB, sortOrder: 1, pairedAt: 100),
            Device(InstanceC, sortOrder: 2, pairedAt: 200),
        };
        Assert.Equal(["b", "c", "a"], Keys(DeviceOrder.Order(devices)));
    }

    [Fact]
    public void EqualSortOrderStillBreaksTiesByPairingTimeThenKey()
    {
        // Determinism matters: two records tied at 0 must not swap between refreshes.
        var devices = new[]
        {
            Device(InstanceA, pairedAt: 100),
            Device(InstanceB, pairedAt: 100),
        };
        Assert.Equal(["a", "b"], Keys(DeviceOrder.Order(devices)));
    }

    [Fact]
    public void NextSortOrderAppendsBelowAnArrangedList()
    {
        var devices = new[]
        {
            Device(InstanceA, sortOrder: 1),
            Device(InstanceB, sortOrder: 7),
        };
        Assert.Equal(8, DeviceOrder.NextSortOrder(devices));
    }

    [Fact]
    public void NextSortOrderStartsAtOneForAnEmptyStore() =>
        Assert.Equal(1, DeviceOrder.NextSortOrder([]));

    [Fact]
    public void NextSortOrderAppendsIntoAnUnarrangedStore()
    {
        // All-zero list: the new row gets 1, which sorts *below* the zero rows. Rows
        // append when they are paired (as on the phone) instead of jumping to the front
        // and pushing aside an arrangement the user made on purpose.
        var devices = new[] { Device(InstanceA, pairedAt: 100), Device(InstanceB, pairedAt: 200) };
        var added = Device(InstanceC, sortOrder: DeviceOrder.NextSortOrder(devices), pairedAt: 300);
        Assert.Equal(["b", "a", "c"], Keys(DeviceOrder.Order(devices.Append(added))));
    }

    [Fact]
    public void TheFirstRowCannotMoveUpOrToTheTop()
    {
        var ordered = DeviceOrder.Order([Device(InstanceA, sortOrder: 1), Device(InstanceB, sortOrder: 2)]);
        Assert.False(DeviceOrder.CanMoveUp(ordered, InstanceA));
        Assert.False(DeviceOrder.CanMoveToTop(ordered, InstanceA));
    }

    [Fact]
    public void TheSecondRowCanMoveUpButIsNotOfferedMoveToTop()
    {
        // "Move to top" on row 2 would do the same thing as "move up", so the phone
        // hides the redundant action; mirror that.
        var ordered = DeviceOrder.Order(
        [
            Device(InstanceA, sortOrder: 1),
            Device(InstanceB, sortOrder: 2),
            Device(InstanceC, sortOrder: 3),
        ]);
        Assert.True(DeviceOrder.CanMoveUp(ordered, InstanceB));
        Assert.False(DeviceOrder.CanMoveToTop(ordered, InstanceB));
        Assert.True(DeviceOrder.CanMoveToTop(ordered, InstanceC));
    }

    [Fact]
    public void MoveUpSwapsWithTheRowAbove()
    {
        var ordered = DeviceOrder.Order(
        [
            Device(InstanceA, sortOrder: 1),
            Device(InstanceB, sortOrder: 2),
            Device(InstanceC, sortOrder: 3),
        ]);
        Assert.True(DeviceOrder.MoveUp(ordered, InstanceC));
        Assert.Equal(["a", "c", "b"], Keys(ordered));
    }

    [Fact]
    public void MoveUpOnTheFirstRowChangesNothing()
    {
        var ordered = DeviceOrder.Order([Device(InstanceA, sortOrder: 1), Device(InstanceB, sortOrder: 2)]);
        Assert.False(DeviceOrder.MoveUp(ordered, InstanceA));
        Assert.Equal(["a", "b"], Keys(ordered));
    }

    [Fact]
    public void MoveToTopPutsTheRowFirst()
    {
        var ordered = DeviceOrder.Order(
        [
            Device(InstanceA, sortOrder: 1),
            Device(InstanceB, sortOrder: 2),
            Device(InstanceC, sortOrder: 3),
        ]);
        Assert.True(DeviceOrder.MoveToTop(ordered, InstanceC));
        Assert.Equal(["c", "a", "b"], Keys(ordered));
    }

    [Fact]
    public void MovingRenumbersSoTheNewOrderSurvivesAnOrderRoundTrip()
    {
        // The point of the renumber: what the user dragged is what the next read shows.
        var ordered = DeviceOrder.Order(
        [
            Device(InstanceA, sortOrder: 1),
            Device(InstanceB, sortOrder: 2),
            Device(InstanceC, sortOrder: 3),
        ]);
        DeviceOrder.MoveToTop(ordered, InstanceC);
        Assert.Equal(1, ordered[0].SortOrder);
        Assert.Equal(2, ordered[1].SortOrder);
        Assert.Equal(3, ordered[2].SortOrder);
        Assert.Equal(["c", "a", "b"], Keys(DeviceOrder.Order(ordered)));
    }

    [Fact]
    public void MovingAnUnarrangedStoreAlsoLocksInTheWholeOrder()
    {
        // Without renumbering, the moved row would be the only one with a SortOrder and
        // every other row (still 0) would keep floating by pairing time.
        var ordered = DeviceOrder.Order(
        [
            Device(InstanceA, pairedAt: 100),
            Device(InstanceB, pairedAt: 300),
            Device(InstanceC, pairedAt: 200),
        ]);
        Assert.Equal(["b", "c", "a"], Keys(ordered));
        Assert.True(DeviceOrder.MoveUp(ordered, InstanceA));
        Assert.Equal(["b", "a", "c"], Keys(ordered));
        Assert.Equal(3, ordered[2].SortOrder);
        Assert.Equal(["b", "a", "c"], Keys(DeviceOrder.Order(ordered)));
    }

    [Fact]
    public void MovingAnUnknownRowIsANoOp()
    {
        var ordered = DeviceOrder.Order([Device(InstanceA, sortOrder: 1)]);
        Assert.False(DeviceOrder.MoveUp(ordered, InstanceB));
        Assert.False(DeviceOrder.MoveToTop(ordered, InstanceB));
        Assert.False(DeviceOrder.CanMoveUp(ordered, InstanceB));
        Assert.False(DeviceOrder.CanMoveToTop(ordered, InstanceB));
    }
}
