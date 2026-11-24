namespace DshMobile.Win;

/// <summary>
/// Presentation order of the paired-computer list, and the two arrangement actions the
/// device card offers (move up / move to top).
/// </summary>
/// <remarks>
/// The phone keeps a fixed order: rows append when they are paired and only the two
/// arrangement actions move them, so the computer used last never jumps to the front
/// (PairedDeviceOrderPolicy.kt). This mirrors that with an explicit <c>SortOrder</c>
/// column instead of array position, because devices.json is rewritten per record and
/// the list is re-read on every refresh.
///
/// <c>SortOrder</c> 0 means "never arranged": every record written before the field
/// existed. A store in that state sorts by pairing time, newest first, which is exactly
/// what the previous version displayed, so an upgrade changes nothing on screen and
/// needs no migration write. A newly paired row takes <c>max + 1</c> and therefore
/// appends below those rows instead of jumping to the top.
/// </remarks>
internal static class DeviceOrder
{
    /// <summary>The rows in display order.</summary>
    internal static List<SavedDevice> Order(IEnumerable<SavedDevice> devices) =>
        devices
            .OrderBy(static d => d.SortOrder)
            .ThenByDescending(static d => d.PairedAt)
            .ThenBy(static d => d.EndpointId, StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// The <c>SortOrder</c> to give a newly paired row: one past the highest, so it
    /// appends. A store that was never arranged has all-zero values, and appending then
    /// means sorting below them - which <see cref="Order"/> already does.
    /// </summary>
    internal static int NextSortOrder(IEnumerable<SavedDevice> devices)
    {
        var highest = 0;
        foreach (var device in devices)
            if (device.SortOrder > highest) highest = device.SortOrder;
        return highest + 1;
    }

    /// <summary>Whether one row can trade places with the row above it.</summary>
    internal static bool CanMoveUp(IReadOnlyList<SavedDevice> ordered, string endpointId) =>
        IndexOf(ordered, endpointId) > 0;

    /// <summary>
    /// Whether one row can jump ahead of at least one other row. The second row is
    /// excluded because "move to top" would be the same result as "move up" there, and
    /// the phone hides the redundant action for the same reason.
    /// </summary>
    internal static bool CanMoveToTop(IReadOnlyList<SavedDevice> ordered, string endpointId) =>
        IndexOf(ordered, endpointId) > 1;

    /// <summary>Move one row one position towards the front; a no-op for the first row.</summary>
    internal static bool MoveUp(List<SavedDevice> ordered, string endpointId)
    {
        var index = IndexOf(ordered, endpointId);
        if (index <= 0) return false;
        var row = ordered[index];
        ordered.RemoveAt(index);
        ordered.Insert(index - 1, row);
        Renumber(ordered);
        return true;
    }

    /// <summary>Move one row to the front; a no-op for the first row.</summary>
    internal static bool MoveToTop(List<SavedDevice> ordered, string endpointId)
    {
        var index = IndexOf(ordered, endpointId);
        if (index <= 0) return false;
        var row = ordered[index];
        ordered.RemoveAt(index);
        ordered.Insert(0, row);
        Renumber(ordered);
        return true;
    }

    /// <summary>
    /// Rewrite <c>SortOrder</c> as 1..N over the given display order, so the next
    /// <see cref="Order"/> call reproduces it exactly and no row is left "unset"
    /// (which would make a later pairing sort unpredictably).
    /// </summary>
    internal static void Renumber(List<SavedDevice> ordered)
    {
        for (var index = 0; index < ordered.Count; index++)
            ordered[index].SortOrder = index + 1;
    }

    private static int IndexOf(IReadOnlyList<SavedDevice> ordered, string endpointId)
    {
        for (var index = 0; index < ordered.Count; index++)
            if (ordered[index].EndpointId == endpointId) return index;
        return -1;
    }
}
