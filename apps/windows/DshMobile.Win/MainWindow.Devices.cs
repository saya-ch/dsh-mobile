using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;
using DshMobile.Win.Resources;

namespace DshMobile.Win;

/// <summary>
/// The device list: card rendering, reachability wiring, deletion with undo, and the
/// two arrangement actions.
/// </summary>
/// <remarks>
/// Lives in its own file because MainWindow.xaml.cs already carries the connection
/// pipeline, the settings page and the WebView policy, and none of that belongs beside
/// card layout.
///
/// Cards are built in code rather than from a DataTemplate: the list is a handful of
/// rows that are rebuilt on every change, so a template would need a full view model
/// layer plus INotifyPropertyChanged plumbing for the same result.
///
/// Every colour is a DynamicResource lookup of a semantic token from
/// design-system/dsh-mobile/MASTER.md, so the light/dark palette swap in App.xaml.cs
/// repaints the cards without touching this code.
/// </remarks>
public partial class MainWindow
{
    private DeviceReachability? _reachability;
    private readonly Dictionary<string, DeviceCardView> _cardViews = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DeviceStatusKind> _observedStatus = new(StringComparer.Ordinal);
    private DispatcherTimer? _relativeTimeTimer;
    private SavedDevice? _undoDevice;
    private DispatcherTimer? _undoTimer;

    /// <summary>How long the undo strip stays after a delete (the phone uses 5s).</summary>
    private static readonly TimeSpan UndoWindow = TimeSpan.FromSeconds(5);

    /// <summary>How often the "last connected" wording is recomputed.</summary>
    private static readonly TimeSpan RelativeTimeTick = TimeSpan.FromSeconds(30);

    /// <summary>The parts of a card that change without the card being rebuilt.</summary>
    private sealed class DeviceCardView
    {
        internal required Ellipse Dot { get; init; }
        internal required TextBlock Status { get; init; }
    }

    /// <summary>Rebuild the whole list from the store plus the latest observations.</summary>
    private void RebuildDeviceList()
    {
        DeviceList.Children.Clear();
        _connectButtons.Clear();
        _cardViews.Clear();
        var now = DateTimeOffset.Now;
        var devices = _store.All;
        var hasDevices = devices.Count > 0;
        NoDevicesText.Visibility = hasDevices ? Visibility.Collapsed : Visibility.Visible;
        // The empty state is the onboarding surface: it already offers the three
        // pairing methods, and one of them opens this panel. Opening the panel as well
        // would show the same instructions twice on a first run.
        AddToggleButton.Visibility = hasDevices ? Visibility.Visible : Visibility.Collapsed;
        if (!hasDevices) ShowAddPanel(false);
        foreach (var device in devices)
            DeviceList.Children.Add(BuildDeviceCard(device, devices, now));
        StartReachability(devices);
        SyncRelativeTimeTimer();
    }

    private Border BuildDeviceCard(
        SavedDevice device, IReadOnlyList<SavedDevice> ordered, DateTimeOffset now)
    {
        var status = DeviceStatus.Resolve(device, _current?.EndpointId, ObservedFor(device));
        var model = new DeviceCardModel(
            EndpointId: device.EndpointId,
            Name: device.Name,
            ChannelLabel: ChannelLabel(device.Channel),
            ShortId: device.ShortId,
            Status: status,
            LastConnectedAt: device.LastConnectedAt,
            ExpiresAt: device.DeviceExpiresAt,
            CanReconnect: device.CanReconnect,
            IsCurrent: status == DeviceStatusKind.Current,
            CanMoveUp: DeviceOrder.CanMoveUp(ordered, device.EndpointId),
            CanMoveToTop: DeviceOrder.CanMoveToTop(ordered, device.EndpointId));

        // Header: status dot + name. The dot sits on the name line, so scrolling the
        // list shows reachability without reading any text.
        var dot = new Ellipse { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center };
        dot.SetResourceReference(Shape.FillProperty, SafeBrushToken(model.StatusBrushToken));
        var name = new TextBlock
        {
            Text = model.Name,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(8, 0, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
            VerticalAlignment = VerticalAlignment.Center,
        };
        name.SetResourceReference(TextBlock.ForegroundProperty, "PrimaryTextBrush");
        var header = new StackPanel { Orientation = Orientation.Horizontal };
        header.Children.Add(dot);
        header.Children.Add(name);

        // Connection mode, identity and credential lifetime.
        var detail = new TextBlock
        {
            Text = model.DetailText,
            FontSize = 12,
            Margin = new Thickness(0, 5, 0, 0),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        detail.SetResourceReference(TextBlock.ForegroundProperty, "SecondaryTextBrush");

        // Status plus recency, in the status colour.
        var statusText = new TextBlock
        {
            Text = model.StatusLine(now),
            FontSize = 12,
            Margin = new Thickness(0, 3, 0, 0),
            TextWrapping = TextWrapping.Wrap,
        };
        statusText.SetResourceReference(TextBlock.ForegroundProperty, SafeBrushToken(model.StatusBrushToken));

        var text = new StackPanel();
        text.Children.Add(header);
        text.Children.Add(detail);
        text.Children.Add(statusText);
        if (model.RepairHint is { } hint)
        {
            var warning = new TextBlock
            {
                Text = hint,
                FontSize = 12,
                Margin = new Thickness(0, 4, 0, 0),
                TextWrapping = TextWrapping.Wrap,
            };
            warning.SetResourceReference(TextBlock.ForegroundProperty, "ErrorBrush");
            text.Children.Add(warning);
        }

        // One primary action, everything else behind a menu. Six equal-weight buttons
        // on every row read as a wall of buttons, made a single device fill a whole
        // screen, and put "delete" on the same footing as "connect".
        var connect = DeviceAction(device.CanReconnect ? Strings.DeviceList_Connect : Strings.DeviceList_Repair,
            92, Strings.DeviceList_ConnectTooltip, ConnectSaved_Click, primary: true);
        connect.Tag = device; // the existing handler reads the record from the button
        connect.Margin = new Thickness(0, 0, 8, 0);
        _connectButtons.Add(connect);

        var menu = new ContextMenu();
        void AddMenu(string header, RoutedEventHandler handler, bool danger = false)
        {
            var item = new MenuItem { Header = header, Tag = device };
            if (danger) item.SetResourceReference(ForegroundProperty, "ErrorBrush");
            item.Click += handler;
            menu.Items.Add(item);
        }

        AddMenu(Strings.DeviceList_MenuRename, RenameDevice_Click);
        // Probing needs a reachable address; an iroh row only has one once a connect
        // starts the sidecar, which is exactly what its status says.
        if (device.Channel != "iroh")
            AddMenu(Strings.DeviceList_MenuCheckNow, (_, _) => CheckDeviceNow(device));
        if (model.CanMoveUp)
            AddMenu(Strings.DeviceList_MenuMoveUp, (_, _) => MoveDevice(device, toTop: false));
        if (model.CanMoveToTop)
            AddMenu(Strings.DeviceList_MenuMoveTop, (_, _) => MoveDevice(device, toTop: true));
        menu.Items.Add(new Separator());
        AddMenu(Strings.DeviceList_MenuDelete, (_, _) => DeleteDevice(device), danger: true);

        var more = new Button
        {
            Content = "⋯",
            MinWidth = 40,
            Padding = new Thickness(0),
            FontSize = 15,
            Tag = device,
            ToolTip = Strings.DeviceList_MoreActions,
            ContextMenu = menu,
        };
        more.SetResourceReference(StyleProperty, "BarButton");
        more.SetValue(AutomationProperties.NameProperty, Strings.DeviceList_MoreActions);
        // A plain click opens the same menu the right mouse button does, so the
        // secondary actions stay discoverable without a visible row of buttons.
        more.Click += (_, _) =>
        {
            menu.PlacementTarget = more;
            menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
            menu.IsOpen = true;
        };
        _connectButtons.Add(more);

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
        };
        actions.Children.Add(connect);
        actions.Children.Add(more);

        // Two columns: information takes the width, the actions stay on the row's
        // baseline instead of dropping to a second line and leaving a gap above them.
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(text);
        grid.Children.Add(actions);
        Grid.SetColumn(actions, 1);
        text.Margin = new Thickness(0, 0, 16, 0);

        // The whole row is the context-menu target, so a right click anywhere offers
        // the same secondary actions (the phone's long press).
        grid.ContextMenu = menu;

        var card = new Border
        {
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(14),
            Padding = new Thickness(16, 13, 16, 13),
            Margin = new Thickness(0, 0, 0, 8),
            Child = grid,
        };
        card.SetResourceReference(Border.BackgroundProperty, "CardBrush");
        card.SetResourceReference(Border.BorderBrushProperty, "OutlineBrush");
        // Double-clicking anywhere on the card opens it, the way a row on the phone
        // does; the buttons stay the discoverable path.
        card.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ClickCount == 2) ConnectDeviceFromCard(device);
        };
        card.ToolTip = model.Name + "\n" + model.IdentityText + "\n" + model.StatusLine(now);

        _cardViews[device.EndpointId] = new DeviceCardView { Dot = dot, Status = statusText };
        return card;
    }

    private Button DeviceAction(
        string text, double minWidth, string tooltip, RoutedEventHandler onClick,
        bool primary = false, bool danger = false)
    {
        var button = new Button { Content = text, MinWidth = minWidth, ToolTip = tooltip };
        if (primary) button.Style = (Style)FindResource("PrimaryButton");
        if (danger) button.Style = (Style)FindResource("DangerButton");
        button.Click += onClick;
        return button;
    }

    /// <summary>
    /// A double-click has no Button to read the record from, so it reuses the connect
    /// path directly. It stops on a busy window instead of starting a second connect.
    /// </summary>
    private void ConnectDeviceFromCard(SavedDevice device)
    {
        if (_busy) return;
        if (!device.CanReconnect || device.GetDeviceToken() is null)
        {
            // Expired or unreadable credential: hand it to the same repair flow the
            // 连接 button uses, by revealing the pairing input with this record armed.
            ShowAddPanel(true);
            DescriptorBox.Focus();
            _pendingAdopt = device;
            return;
        }
        _ = ConnectToAsync(device, null, null);
    }

    private static string ChannelLabel(string channel) => channel switch
    {
        "lan" => Strings.Channel_Lan,
        "remote" => Strings.Channel_Remote,
        _ => "iroh",
    };

    /// <summary>
    /// A status token that is guaranteed to resolve, falling back to the muted text
    /// brush when the palette does not define it.
    /// </summary>
    /// <remarks>
    /// <see cref="DeviceStatus.BrushToken"/> names semantic tokens (Success/Warning/…).
    /// A <c>DynamicResource</c> reference to a key that does not exist leaves the
    /// property null - an invisible dot and uncoloured text - rather than failing loudly,
    /// so an incomplete palette would silently erase the very thing this page adds. The
    /// lookup makes that impossible while keeping the live palette swap for every token
    /// that does exist.
    /// </remarks>
    private string SafeBrushToken(string token) =>
        TryFindResource(token) is null ? "SecondaryTextBrush" : token;

    // ---- Reachability ----------------------------------------------------------

    private DeviceStatusKind? ObservedFor(SavedDevice device) =>
        _observedStatus.TryGetValue(device.EndpointId, out var kind) ? kind : null;

    /// <summary>
    /// Start (or refresh) the background poller. Its results arrive on a worker thread,
    /// so they are marshalled to the UI thread and applied to the one card they concern
    /// instead of rebuilding the list, which would move rows under the pointer.
    /// </summary>
    private void StartReachability(IReadOnlyList<SavedDevice> devices)
    {
        if (_reachability is null)
        {
            _reachability = new DeviceReachability(
                DeviceReachability.ProbeAsync,
                OnReachabilityObserved,
                Log,
                // A connect owns the network and is renewing the very credential a probe
                // would race, so polling waits for it.
                () => _busy);
            // The window owns the poller, so it must stop it: a background probe that
            // outlives the window would keep a socket and a thread alive after the last
            // card is gone.
            Closed += (_, _) =>
            {
                _reachability?.Dispose();
                _reachability = null;
                _relativeTimeTimer?.Stop();
                _relativeTimeTimer = null;
                _undoTimer?.Stop();
                _undoTimer = null;
            };
        }
        _reachability.Refresh(devices);
    }

    private void OnReachabilityObserved(ReachabilityObservation observation)
    {
        try
        {
            Dispatcher.BeginInvoke(new Action(() => ApplyObservation(observation)));
        }
        catch (Exception error)
        {
            // The window is closing; the poller is disposed with it.
            Log("reachability dispatch failed: " + error.Message);
        }
    }

    private void ApplyObservation(ReachabilityObservation observation)
    {
        _observedStatus[observation.EndpointId] = observation.Kind;
        if (!_cardViews.TryGetValue(observation.EndpointId, out var view)) return;
        var device = _store.All.FirstOrDefault(d => d.EndpointId == observation.EndpointId);
        if (device is null) return;
        var status = DeviceStatus.Resolve(device, _current?.EndpointId, observation.Kind);
        var token = SafeBrushToken(DeviceStatus.BrushToken(status));
        view.Dot.SetResourceReference(Shape.FillProperty, token);
        view.Status.SetResourceReference(TextBlock.ForegroundProperty, token);
        view.Status.Text = StatusLine(device, status, DateTimeOffset.Now);
    }

    private string StatusLine(SavedDevice device, DeviceStatusKind status, DateTimeOffset now) =>
        new DeviceCardModel(
            device.EndpointId, device.Name, ChannelLabel(device.Channel), device.ShortId,
            status, device.LastConnectedAt, device.DeviceExpiresAt, device.CanReconnect,
            status == DeviceStatusKind.Current, false, false).StatusLine(now);

    /// <summary>
    /// "最近连接 3 分钟前" goes stale while the window stays open, so the wording is
    /// recomputed periodically. Only the status lines are touched - rebuilding the list
    /// on a timer would fight the user's pointer.
    /// </summary>
    private void SyncRelativeTimeTimer()
    {
        if (_cardViews.Count == 0)
        {
            _relativeTimeTimer?.Stop();
            return;
        }
        if (_relativeTimeTimer is null)
        {
            _relativeTimeTimer = new DispatcherTimer { Interval = RelativeTimeTick };
            _relativeTimeTimer.Tick += (_, _) => RefreshRelativeTimes();
        }
        _relativeTimeTimer.Start();
    }

    private void RefreshRelativeTimes()
    {
        var now = DateTimeOffset.Now;
        foreach (var device in _store.All)
        {
            if (!_cardViews.TryGetValue(device.EndpointId, out var view)) continue;
            var status = DeviceStatus.Resolve(device, _current?.EndpointId, ObservedFor(device));
            view.Status.Text = StatusLine(device, status, now);
        }
    }

    private void CheckDeviceNow(SavedDevice device)
    {
        if (_busy) return;
        _reachability?.CheckNow(device, Log);
        Log("reachability re-check requested for " + device.ShortId);
    }

    // ---- Arrangement -----------------------------------------------------------

    private void MoveDevice(SavedDevice device, bool toTop)
    {
        if (_busy) return;
        var moved = toTop
            ? _store.MoveToTop(device.EndpointId, Log)
            : _store.MoveUp(device.EndpointId, Log);
        if (!moved) return;
        RebuildDeviceList();
        Log((toTop ? "moved to top: " : "moved up: ") + device.ShortId);
    }

    // ---- Delete with undo ------------------------------------------------------

    /// <summary>Remove the record and offer an undo strip for a few seconds.</summary>
    /// <remarks>
    /// No confirmation dialog: a five second undo is both faster and safer than a modal,
    /// and it is what the phone does. Undo restores the local record only - the
    /// computer-side authorization is not part of this file, so the record comes back
    /// without asking the computer, while a credential the computer itself revoked still
    /// needs a fresh pairing.
    ///
    /// A live session is deliberately left running: deleting the record must not tear
    /// down a connection the user is looking at.
    /// </remarks>
    private void DeleteDevice(SavedDevice device)
    {
        if (_busy) return;
        _store.Remove(device.EndpointId, Log);
        _observedStatus.Remove(device.EndpointId);
        _reachability?.Forget(device.EndpointId);
        RebuildDeviceList();
        ShowUndoBar(device);
        Log("removed saved device: " + device.EndpointId);
    }

    private void ShowUndoBar(SavedDevice device)
    {
        _undoDevice = device;
        UndoText.Text = string.Format(Strings.DeviceList_UndoDeleted, device.Name);
        UndoBar.Visibility = Visibility.Visible;
        _undoTimer?.Stop();
        _undoTimer = new DispatcherTimer { Interval = UndoWindow };
        _undoTimer.Tick += (_, _) =>
        {
            _undoTimer?.Stop();
            _undoTimer = null;
            HideUndoBar();
        };
        _undoTimer.Start();
    }

    private void HideUndoBar()
    {
        UndoBar.Visibility = Visibility.Collapsed;
        _undoDevice = null;
    }

    private void UndoDelete_Click(object sender, RoutedEventArgs e)
    {
        var device = _undoDevice;
        _undoTimer?.Stop();
        _undoTimer = null;
        HideUndoBar();
        if (device is null) return;
        // Not Upsert: that keeps the *stored* order and assigns a new one for an unknown
        // endpoint, which would move the restored row to the bottom.
        _store.Restore(device, Log);
        RebuildDeviceList();
        Log("restored saved device: " + device.EndpointId);
    }
}

