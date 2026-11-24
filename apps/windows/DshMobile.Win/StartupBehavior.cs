namespace DshMobile.Win;

/// <summary>
/// Decides what the client does right after its window loads.
/// </summary>
/// <remarks>
/// The settings page has offered "启动时：显示设备列表 / 自动连接上次的电脑" since the
/// preference was added, but nothing read it: every launch showed the device list. The
/// rule below is the whole decision, kept separate from the window so it can be tested
/// without WPF:
/// <list type="bullet">
/// <item>anything other than <c>last</c> stays on the device list;</item>
/// <item>the last successfully connected computer wins when it can still reconnect;</item>
/// <item>otherwise the most recently paired reconnectable computer is used, so a first
/// launch after upgrading the setting still does something sensible;</item>
/// <item>a computer whose credential is expired or unreadable is never auto-connected —
/// that would only produce a failure dialog on every launch.</item>
/// </list>
/// </remarks>
internal static class StartupBehavior
{
    internal static bool WantsAutoConnect(string? startPage) =>
        startPage == AppSettings.StartPageLastDevice;

    /// <summary>
    /// True when the record carries a usable, unexpired device credential.
    /// </summary>
    /// <remarks>
    /// <see cref="SavedDevice.GetDeviceToken"/> catches a DPAPI failure, but a record
    /// whose sealed token is not valid base64 throws <see cref="FormatException"/> before
    /// DPAPI is reached — a hand-edited or corrupted devices.json. Launch must not fail
    /// because of it, so the probe treats any throw as "not usable".
    /// </remarks>
    internal static bool CanAutoConnect(SavedDevice device)
    {
        if (!device.CanReconnect) return false;
        try { return device.GetDeviceToken() is not null; }
        catch { return false; }
    }

    /// <summary>
    /// The computer to reconnect on launch, or null when the device list should show.
    /// <paramref name="devices"/> is expected in most-recent-first order.
    /// </summary>
    internal static SavedDevice? SelectAutoConnectTarget(
        string? startPage,
        IReadOnlyList<SavedDevice> devices,
        string? lastConnectedEndpointId,
        Func<SavedDevice, bool>? canConnect = null)
    {
        if (!WantsAutoConnect(startPage) || devices.Count == 0) return null;
        var usable = canConnect ?? CanAutoConnect;
        if (!string.IsNullOrEmpty(lastConnectedEndpointId))
        {
            var previous = devices.FirstOrDefault(
                device => device.EndpointId == lastConnectedEndpointId && usable(device));
            if (previous is not null) return previous;
        }
        return devices.FirstOrDefault(usable);
    }

    /// <summary>Prefix a failure dialog so the user knows why the device list appeared.</summary>
    internal static string DescribeAutoConnectFailure(string hint, string deviceName) =>
        $"启动时自动连接「{deviceName}」失败，已返回设备列表。\n\n{hint}";

    /// <summary>
    /// Record which computer was connected last, so the next launch can prefer it.
    /// Returns true when the stored value changed and was persisted.
    /// </summary>
    /// <remarks>
    /// The device list is ordered by pairing time, which is not the same question as
    /// "which computer did the user use last". The value is only written when it
    /// actually changes, so a reconnect loop does not rewrite settings.json every time.
    /// </remarks>
    internal static bool RememberLastDevice(AppSettings settings, string dataRoot, SavedDevice device)
    {
        if (settings.LastDeviceEndpointId == device.EndpointId) return false;
        settings.LastDeviceEndpointId = device.EndpointId;
        settings.Save(dataRoot);
        return true;
    }
}
