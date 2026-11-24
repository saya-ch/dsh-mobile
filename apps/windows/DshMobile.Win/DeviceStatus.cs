namespace DshMobile.Win;

/// <summary>
/// Reachability of one paired computer, as the device list shows it.
/// </summary>
/// <remarks>
/// The first seven values are the states the phone's list can show
/// (MainActivity.setDeviceStatusText + PairedDeviceStatus). <see cref="ConnectToCheck"/>
/// is the eighth, desktop-side equivalent of the phone's
/// <c>iroh_status_connect_to_check</c>: an iroh row cannot be probed before its sidecar
/// tunnel exists, so claiming "unreachable" would be a lie.
/// </remarks>
internal enum DeviceStatusKind
{
    /// <summary>This window currently holds a live session to this computer.</summary>
    Current,

    /// <summary>The last probe completed and the gateway answered as this computer.</summary>
    Reachable,

    /// <summary>No result yet for this round.</summary>
    Checking,

    /// <summary>The last probe did not complete: refused, timed out, unresolved.</summary>
    Unreachable,

    /// <summary>The computer answered but rejected the stored device credential.</summary>
    Revoked,

    /// <summary>The local device credential has expired or cannot be unsealed.</summary>
    Expired,

    /// <summary>A gateway answered at this address but is not the paired computer.</summary>
    AddressChanged,

    /// <summary>iroh rows need the sidecar tunnel before they can be probed.</summary>
    ConnectToCheck,
}

/// <summary>
/// The single place where a device status becomes user-visible text and a colour token.
/// </summary>
/// <remarks>
/// Keeping the enum, its wording and its brush mapping together is the point: the card
/// renderer never hard-codes a colour or a status string, so adding a state is a
/// one-file change and the light/dark palettes stay authoritative (every token named
/// here is a <c>DynamicResource</c> defined in App.xaml and replaced by App.xaml.cs).
/// </remarks>
internal static class DeviceStatus
{
    /// <summary>Short label for the status line on a card.</summary>
    internal static string Text(DeviceStatusKind kind) => kind switch
    {
        DeviceStatusKind.Current => "当前连接",
        DeviceStatusKind.Reachable => "可达",
        DeviceStatusKind.Checking => "检测中…",
        DeviceStatusKind.Unreachable => "暂不可达",
        DeviceStatusKind.Revoked => "电脑端已移除",
        DeviceStatusKind.Expired => "配对已过期",
        DeviceStatusKind.AddressChanged => "地址可能已变化",
        DeviceStatusKind.ConnectToCheck => "连接后可检测",
        _ => "检测中…",
    };

    /// <summary>
    /// Semantic brush key for the status dot and label. Green reads as usable, amber as
    /// "look at this", red as "this pairing is gone", and muted grey as "no answer yet"
    /// so an unprobed row never looks like a failure.
    /// </summary>
    internal static string BrushToken(DeviceStatusKind kind) => kind switch
    {
        DeviceStatusKind.Current => "SuccessBrush",
        DeviceStatusKind.Reachable => "SuccessBrush",
        DeviceStatusKind.Checking => "SecondaryTextBrush",
        DeviceStatusKind.ConnectToCheck => "SecondaryTextBrush",
        DeviceStatusKind.Unreachable => "WarningBrush",
        DeviceStatusKind.AddressChanged => "WarningBrush",
        DeviceStatusKind.Revoked => "ErrorBrush",
        DeviceStatusKind.Expired => "ErrorBrush",
        _ => "SecondaryTextBrush",
    };

    /// <summary>Whether the row can be opened right now (a live session or a usable credential).</summary>
    internal static bool CanConnect(DeviceStatusKind kind) =>
        kind is DeviceStatusKind.Current or DeviceStatusKind.Reachable or DeviceStatusKind.Unreachable
            or DeviceStatusKind.Checking or DeviceStatusKind.ConnectToCheck;

    /// <summary>
    /// Combine everything known about one record into the state to draw.
    /// </summary>
    /// <param name="device">The saved record.</param>
    /// <param name="currentEndpointId">Endpoint of the live session, if any.</param>
    /// <param name="probeResult">
    /// The last reachability observation, or null when this record has not been probed
    /// (iroh rows are never probed; a just-paired row has no round yet).
    /// </param>
    /// <remarks>
    /// Precedence matters. A live session beats everything, because it is direct
    /// evidence. A computer-side revocation is sticky: a probe cannot observe a
    /// revoked credential through the unauthenticated discovery endpoint, so a later
    /// "reachable" must not erase it. An expired local credential beats a probe too:
    /// the computer may well be up, but this record still cannot connect.
    /// </remarks>
    internal static DeviceStatusKind Resolve(
        SavedDevice device, string? currentEndpointId, DeviceStatusKind? probeResult)
    {
        if (device.EndpointId == currentEndpointId) return DeviceStatusKind.Current;
        if (probeResult == DeviceStatusKind.Revoked) return DeviceStatusKind.Revoked;
        if (!device.CanReconnect) return DeviceStatusKind.Expired;
        if (probeResult is not null) return probeResult.Value;
        // iroh rows reach their gateway through the sidecar's loopback proxy, which only
        // exists once a connect starts, so there is nothing to probe from the list.
        if (device.Channel == "iroh") return DeviceStatusKind.ConnectToCheck;
        return DeviceStatusKind.Checking;
    }
}
