using DshMobile.Win.Resources;

namespace DshMobile.Win;

/// <summary>
/// Everything one device card displays, computed from a saved record plus the latest
/// reachability observation. This is the seam between the device-list logic and its
/// presentation: the model carries text and semantic brush names only, never a colour
/// value or a control, so the card renderer can be restyled without touching the
/// polling, ordering or undo code.
/// </summary>
/// <remarks>
/// The wording mirrors the phone's row (MainActivity.setDeviceStatusText): a status
/// label, the last time this client opened the computer, the connection mode, and when
/// the device credential expires.
/// </remarks>
internal sealed record DeviceCardModel(
    string EndpointId,
    string Name,
    string ChannelLabel,
    string ShortId,
    DeviceStatusKind Status,
    long LastConnectedAt,
    long ExpiresAt,
    bool CanReconnect,
    bool IsCurrent,
    bool CanMoveUp,
    bool CanMoveToTop)
{
    /// <summary>The status label alone, e.g. "可达".</summary>
    internal string StatusText => DeviceStatus.Text(Status);

    /// <summary>Semantic brush key for the dot and the status text.</summary>
    internal string StatusBrushToken => DeviceStatus.BrushToken(Status);

    /// <summary>Connection mode and identity, e.g. "局域网 · a1b2c3d4e5f6…".</summary>
    internal string IdentityText => string.Format(Strings.DeviceCard_Identity, ChannelLabel, ShortId);

    /// <summary>
    /// Credential lifetime, or an empty string for a record with no recorded expiry.
    /// The caller appends this to <see cref="IdentityText"/>.
    /// </summary>
    internal string ExpiryText =>
        ExpiresAt > 0 ? string.Format(Strings.DeviceCard_Expiry, RelativeTime.AbsoluteDate(ExpiresAt)) : string.Empty;

    /// <summary>
    /// Status plus recency, e.g. "可达 · 最近连接 3 分钟前" - or "可达 · 从未连接" for a
    /// record that has never been opened from this client.
    /// </summary>
    internal string StatusLine(DateTimeOffset now)
    {
        var relative = RelativeTime.Format(LastConnectedAt, now);
        var connected = LastConnectedAt > 0 ? string.Format(Strings.DeviceCard_LastConnected, relative) : relative;
        return string.Format(Strings.DeviceCard_StatusLine, StatusText, connected);
    }

    /// <summary>The one repair instruction a broken record needs, or null when it is fine.</summary>
    internal string? RepairHint => CanReconnect
        ? null
        : Strings.DeviceCard_RepairHint;

    /// <summary>The full secondary line under the name.</summary>
    internal string DetailText
    {
        get
        {
            var expiry = ExpiryText;
            return expiry.Length == 0 ? IdentityText : string.Format(Strings.DeviceCard_Detail, IdentityText, expiry);
        }
    }
}
