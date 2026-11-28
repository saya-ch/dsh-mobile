using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Interop;
using DshMobile.Win.Resources;
using Microsoft.Web.WebView2.Core;

namespace DshMobile.Win;

/// <summary>
/// Portable Windows client with two independent pages: a connect page (saved devices +
/// an optional one-time pairing input) and the DSH Mobile page in WebView2.
/// Once paired, later launches reconnect with iroh Hello + Gateway native-renew, so no
/// QR code is needed again until the device credential expires or is revoked.
/// No installer, no registry writes.
/// </summary>
public partial class MainWindow : Window
{
    private static readonly string Root = AppContext.BaseDirectory;
    // Resolved once per process: the executable's own folder when it is writable, otherwise
    // the user's local application data. See AppDataPaths for why this cannot be assumed.
    private static readonly string DataRoot = AppDataPaths.DataRoot;
    private static readonly string WebViewProfile = Path.Combine(DataRoot, "webview2");
    private static readonly string LogPath = Path.Combine(DataRoot, "client.log");
    private static readonly string DevicesPath = Path.Combine(DataRoot, "devices.json");
    private static readonly string IdentityDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh-mobile-win", "iroh");

    // The sidecar gives every connect 15s (CONNECT_BUDGET). A Host that has just
    // restarted needs longer for its N0 discovery record to propagate.
    private const int MaxConnectAttempts = 3;

    private readonly object _logLock = new();
    private readonly DeviceStore _store;
    private readonly List<Button> _connectButtons = [];
    private readonly SemaphoreSlim _webViewGate = new(1, 1);

    private IrohCarrier? _carrier;
    private SavedDevice? _current;
    private BackgroundEventWatcher? _watcher;
    private System.Windows.Forms.NotifyIcon? _trayIcon;
    private System.Drawing.Icon? _trayIconHandle;
    private AppIcons.Choice _appIcon = AppIcons.All[0];
    private AppSettings _settings = new();
    private CoreWebView2? _core;
    private bool _certificateHandlerAttached;
    private CancellationTokenSource? _connectCts;
    private string _irohDiagnostics = string.Empty;
    private bool _busy;
    private bool _userCancelled;
    private bool _scanning;
    private DiscoveredGateway? _selectedDiscovery;
    private CancellationTokenSource? _scanCts;
    private SavedDevice? _pendingAdopt;
    private bool _dataWritable = true;
    private string? _dataFolderError;
    /// <summary>Set while the launch-time auto-connect runs, so its failure can say so.</summary>
    private bool _autoConnecting;

    /// <summary>The release the footer row will install; null until a check finds one.</summary>
    private WindowsRelease? _updateRelease;
    /// <summary>Cancels a running download or checksum when 取消 or a window close asks.</summary>
    private CancellationTokenSource? _updateCts;
    /// <summary>True while download/verify/launch runs, so a second click cannot start one.</summary>
    private bool _updateRunning;

    public MainWindow()
    {
        InitializeComponent();
        FitToScreen();
        // A portable folder under Program Files is readable but refuses new files, and
        // Directory.CreateDirectory throws for it. The client still works for this run,
        // so the failure is reported once instead of ending the process.
        _dataWritable = AppDataPaths.IsWritable;
        _dataFolderError = AppDataPaths.PortableRejection;
        _settings = AppSettings.Load(DataRoot);
        _appIcon = AppIcons.Resolve(_settings.Icon);
        ApplyAppIcon();
        _store = new DeviceStore(DevicesPath, Log);
        Log($"portable root: {Root}");
        Log($"iroh identity: {IdentityDir}");
        RefreshDeviceList();
        // The device page's header is fixed, so the scrolling body owns the page's
        // vertical rhythm: centred while it only holds the empty state, pinned to the
        // top once cards are under it. The empty state already drives the section
        // header's visibility, so it drives this too.
        NoDevicesText.IsVisibleChanged += (_, _) => SyncDevicePageLayout();
        SyncDevicePageLayout();
        Loaded += async (_, _) =>
        {
            // A new window hands keyboard focus to its first focusable element, which is the
            // Devices rail button; the RailItem template then draws its 2px accent ring
            // around the current destination on launch, reading as a stray blue outline.
            // Clearing it keeps Tab navigation and every ring the user actually earns.
            Keyboard.ClearFocus();
            ApplyCaptionColor();
            if (!_dataWritable) ShowDataFolderWarning();
            await InitializeWebViewAsync();
            await AutoConnectOnLaunchAsync();
        };
        Closed += (_, _) =>
        {
            _updateCts?.Cancel();
            DisconnectCore();
            _trayIcon?.Dispose();
            _trayIcon = null;
        };
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>DWMWA_USE_IMMERSIVE_DARK_MODE: dark titlebar with light glyphs.</summary>
    private const int DwmwaUseImmersiveDarkMode = 20;
    /// <summary>The same attribute before Windows 10 20H1/2004 answered to id 19.</summary>
    private const int DwmwaUseImmersiveDarkModeLegacy = 19;
    /// <summary>DWMWA_BORDER_COLOR (Windows 11): the 1px window frame.</summary>
    private const int DwmwaBorderColor = 34;
    /// <summary>DWMWA_CAPTION_COLOR (Windows 11): the titlebar background.</summary>
    private const int DwmwaCaptionColor = 35;

    /// <summary>
    /// Paint the DWM caption with the same token as the page canvas, so the native
    /// titlebar and the page below it read as one surface.
    /// </summary>
    /// <remarks>
    /// Two attributes are needed, not one. <c>DWMWA_CAPTION_COLOR</c> only changes the
    /// fill; the title text and the minimize/maximize/close glyphs are drawn by DWM in
    /// the system's light or dark ink. Setting the fill alone left a light caption and
    /// light glyphs over a dark page - the brightest band on the screen. The immersive
    /// flag switches DWM's own ink, so it is set first and the fill second. Both are
    /// re-applied on a runtime theme change through <see cref="RefreshCaptionColor"/>.
    /// </remarks>
    private void ApplyCaptionColor()
    {
        try
        {
            if (FindResource("AppBackgroundBrush") is not SolidColorBrush brush) return;
            var hwnd = new WindowInteropHelper(this).Handle;
            if (hwnd == IntPtr.Zero) return;
            var c = brush.Color;
            // COLORREF is 0x00BBGGRR; DWMWA_CAPTION_COLOR and DWMWA_BORDER_COLOR both
            // take it in that order.
            int colorref = c.R | (c.G << 8) | (c.B << 16);
            int dark = IsDarkColor(c) ? 1 : 0;
            if (DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int)) != 0)
                DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkModeLegacy, ref dark, sizeof(int));
            DwmSetWindowAttribute(hwnd, DwmwaCaptionColor, ref colorref, sizeof(int));
            // Windows 11 draws a frame in the system accent; against a dark canvas it is
            // the same defect, one pixel wide.
            DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref colorref, sizeof(int));
        }
        catch
        {
            // These attributes need Windows 10 1809 or Windows 11; on anything older
            // the system caption is kept, which is the pre-existing behaviour.
        }
    }

    /// <summary>
    /// Whether a palette surface is dark enough to want a dark caption. The page canvas
    /// is the reference, so the caption follows the palette the user is looking at
    /// rather than the stored preference (which "system" leaves unset).
    /// </summary>
    private static bool IsDarkColor(Color color) =>
        (0.2126 * color.R + 0.7152 * color.G + 0.0722 * color.B) < 128;

    /// <summary>
    /// Look for a newer Windows client on the release track, then run the update.
    /// </summary>
    /// <remarks>
    /// The footer control is a two-step button: the first click asks the release API, and
    /// once a release is known the same button reads "更新到 x.y.z" and downloads, verifies
    /// and starts the installer (<see cref="UpdateInstaller"/>). The SHA-256 comparison is
    /// the gate - a mismatch deletes the download and nothing runs. The process exits once
    /// the installer starts, because Inno Setup cannot replace the executable this process
    /// holds open; the installer is pinned to this folder with <c>/DIR</c> so <c>data\</c>
    /// (pairings, settings, logs) stays beside the upgraded binary.
    /// <para>
    /// The failure copy for an incompatible protocol or an HTTP 426 sends the user here,
    /// so this has to resolve to something real.
    /// </para>
    /// </remarks>
    private async void CheckUpdate_Click(object sender, RoutedEventArgs e)
    {
        if (_updateRunning) return;
        if (_updateRelease is { } release)
        {
            await RunUpdateAsync(release);
            return;
        }
        await CheckForUpdateAsync();
    }

    /// <summary>Ask the release API and turn the footer row into the right next action.</summary>
    private async Task CheckForUpdateAsync()
    {
        CheckUpdateButton.IsEnabled = false;
        CheckUpdateButton.Content = Strings.Update_CheckingButton;
        ManualUpdateButton.Visibility = Visibility.Collapsed;
        ShowUpdateProgress(false);
        SetUpdateText(Strings.Update_Checking, error: false);
        try
        {
            using var client = NewGitHubClient(TimeSpan.FromSeconds(15));
            var json = await client.GetStringAsync(UpdateCheck.ReleasesApi);
            var latest = UpdateCheck.SelectLatest(json, CurrentVersion);
            if (latest is null)
            {
                _updateRelease = null;
                CheckUpdateButton.Content = Strings.Update_Check;
                SetUpdateText(string.Format(Strings.Update_UpToDate, CurrentVersion), error: false);
            }
            else if (latest.SetupUrl is null)
            {
                // An older release carries only the portable zip: there is nothing this
                // flow can install and verify, so the row points at the release page.
                _updateRelease = null;
                CheckUpdateButton.Content = Strings.Update_Check;
                SetUpdateText(
                    string.Format(Strings.Update_FoundNoInstaller,
                        latest.Version, CurrentVersion, UpdateCheck.ReleasesPage), error: false);
                RevealManualDownload();
            }
            else
            {
                _updateRelease = latest;
                CheckUpdateButton.Content = string.Format(Strings.Update_To, latest.Version);
                SetUpdateText(
                    string.Format(Strings.Update_Found, latest.Version, CurrentVersion), error: false);
            }
        }
        catch (Exception error)
        {
            Log("update check failed: " + error);
            _updateRelease = null;
            CheckUpdateButton.Content = Strings.Update_Check;
            SetUpdateText(
                string.Format(Strings.Update_CheckFailed,
                    UpdatePayload.DescribeCheckFailure(error), UpdateCheck.ReleasesPage), error: true);
            RevealManualDownload();
        }
        finally
        {
            CheckUpdateButton.IsEnabled = true;
        }
    }

    /// <summary>Download, verify and start the installer; the window exits on success.</summary>
    private async Task RunUpdateAsync(WindowsRelease release)
    {
        _updateRunning = true;
        _updateCts?.Dispose();
        _updateCts = new CancellationTokenSource();
        var token = _updateCts.Token;
        CheckUpdateButton.IsEnabled = false;
        CheckUpdateButton.Content = Strings.Update_Downloading;
        CancelUpdateButton.IsEnabled = true;
        ManualUpdateButton.Visibility = Visibility.Collapsed;
        SetUpdateText(
            string.Format(Strings.Update_DownloadingDetail, release.Version),
            error: false);
        ShowUpdateProgress(true);
        SetProgress(UpdateStage.Download, 0, null);
        try
        {
            // The transfer deadlines live in UpdateInstaller, so this client must not add
            // a shorter fixed timeout: a 49 MB installer over a slow link is legitimate
            // and would otherwise be aborted mid-transfer.
            using var client = NewGitHubClient(Timeout.InfiniteTimeSpan);
            var installer = new UpdateInstaller(client);
            var progress = new Progress<UpdateProgress>(
                report => SetProgress(report.Stage, report.Received, report.Total));
            var outcome = await installer.InstallAsync(release, Root, progress, token);
            if (!outcome.Ok)
            {
                ShowUpdateFailure(outcome.Failure!, release);
                return;
            }
            ShowUpdateProgress(false);
            SetUpdateText(
                string.Format(Strings.Update_InstallerStarted, release.Version),
                error: false);
            Log("update installer started: " + release.Version);
            // One painted frame so the line above is readable before the window goes.
            await Task.Delay(700);
            Application.Current.Shutdown();
        }
        catch (OperationCanceledException)
        {
            ShowUpdateProgress(false);
            SetUpdateText(Strings.Update_Cancelled, error: false);
            CheckUpdateButton.Content = string.Format(Strings.Update_To, release.Version);
            CheckUpdateButton.IsEnabled = true;
        }
        catch (Exception error)
        {
            ShowUpdateFailure(
                new UpdateFailure(
                    string.Format(Strings.Update_Failed, error.Message, UpdateCheck.ReleasesPage),
                    error.Message),
                release);
        }
        finally
        {
            _updateRunning = false;
            CancelUpdateButton.IsEnabled = true;
        }
    }

    /// <summary>
    /// Show a failed step in place, keeping both the retry and the manual download link
    /// reachable - a failed update must never leave the user with no way forward.
    /// </summary>
    private void ShowUpdateFailure(UpdateFailure failure, WindowsRelease release)
    {
        Log("update failure: " + failure.Message +
            (string.IsNullOrEmpty(failure.Detail) ? string.Empty : " / " + failure.Detail));
        ShowUpdateProgress(false);
        CancelUpdateButton.IsEnabled = true;
        if (failure.Cancelled)
        {
            SetUpdateText(Strings.Update_Cancelled, error: false);
        }
        else
        {
            SetUpdateText(
                failure.Message +
                (string.IsNullOrEmpty(failure.Detail)
                    ? string.Empty
                    : string.Format(Strings.Update_Detail, failure.Detail)),
                error: true);
            RevealManualDownload();
        }
        CheckUpdateButton.Content = string.Format(Strings.Update_To, release.Version);
        CheckUpdateButton.IsEnabled = true;
    }

    /// <summary>A GitHub client tagged with this client's version, which the API requires.</summary>
    private static HttpClient NewGitHubClient(TimeSpan timeout)
    {
        var client = new HttpClient { Timeout = timeout };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("dsh-mobile-windows/" + CurrentVersion);
        return client;
    }

    /// <summary>
    /// Reveal the manual-download escape hatch and scroll it into view.
    /// </summary>
    /// <remarks>
    /// The row is the last thing on a long settings page, so a failure that fills four
    /// lines would otherwise push its own escape hatch below the fold.
    /// </remarks>
    private void RevealManualDownload()
    {
        ManualUpdateButton.Visibility = Visibility.Visible;
        ManualUpdateButton.BringIntoView();
    }

    /// <summary>Write the update status line; failures take the error colour.</summary>
    private void SetUpdateText(string text, bool error)
    {
        UpdateResultText.Visibility = Visibility.Visible;
        UpdateResultText.Text = text;
        UpdateResultText.Foreground = error
            ? (Brush)FindResource("ErrorBrush")
            : (Brush)FindResource("SecondaryTextBrush");
    }

    /// <summary>Show or hide the progress row (bar, byte counter and 取消).</summary>
    private void ShowUpdateProgress(bool show)
    {
        UpdateProgressPanel.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        if (!show) return;
        // The row sits at the bottom of a long settings page, so a transfer would start
        // below the fold; bringing it into view is the only thing that makes the bar and
        // the 取消 button discoverable without scrolling.
        UpdateProgressPanel.BringIntoView();
    }

    /// <summary>Paint one progress report onto the bar and its counter.</summary>
    private void SetProgress(UpdateStage stage, long received, long? total)
    {
        var progress = new UpdateProgress(stage, received, total);
        UpdateProgressBar.Value = progress.Percent ?? 0;
        UpdateProgressText.Text = UpdatePayload.DescribeProgress(progress);
    }

    /// <summary>Stop the transfer; the 取消 button and a closing window both come here.</summary>
    private void CancelUpdate_Click(object sender, RoutedEventArgs e)
    {
        if (!_updateRunning) return;
        CancelUpdateButton.IsEnabled = false;
        UpdateProgressText.Text = Strings.Update_Cancelling;
        _updateCts?.Cancel();
    }

    /// <summary>Open the release page in the browser, for every failure that needs it.</summary>
    private void OpenReleases_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo(UpdateCheck.ReleasesPage) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            Log("open releases page failed: " + error);
            MessageBox.Show(this, string.Format(Strings.Update_OpenBrowserFailed, UpdateCheck.ReleasesPage),
                Strings.Update_OpenDownloadPageFailedTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    /// <summary>The released identifier, without the build metadata after '+'.</summary>
    private static string CurrentVersion =>
        (System.Reflection.CustomAttributeExtensions
            .GetCustomAttribute<System.Reflection.AssemblyInformationalVersionAttribute>(
                typeof(MainWindow).Assembly)?.InformationalVersion
         ?? typeof(MainWindow).Assembly.GetName().Version?.ToString(3)
         ?? "0.1.0").Split('+')[0];

    /// <summary>Re-apply the caption colour after a runtime theme change.</summary>
    internal void RefreshCaptionColor() => ApplyCaptionColor();

    /// <summary>
    /// Repaint the saved-device list.
    /// </summary>
    /// <remarks>
    /// The card layout, reachability wiring and undo logic live in MainWindow.Devices.cs;
    /// this stays the one entry point every caller already uses.
    /// </remarks>
    private void RefreshDeviceList() => RebuildDeviceList();

    /// <summary>
    /// Tell the user once that settings, paired computers and the log cannot be saved,
    /// and offer to open the download page for a writable copy of the client.
    /// </summary>
    private void ShowDataFolderWarning()
    {
        Log("portable data folder is not writable: " + (_dataFolderError ?? "unknown"));
        var result = MessageBox.Show(this,
            PortableData.UnwritableMessage +
            string.Format(Strings.AppData_DetailError, _dataFolderError ?? Strings.AppData_Unknown) +
            string.Format(Strings.AppData_DataDirectory, DataRoot),
            PortableData.UnwritableTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
        _ = result;
    }

    /// <summary>
    /// Launch behaviour from the settings page: "显示设备列表" leaves the connect page
    /// alone, "自动连接上次的电脑" reconnects the last computer and falls back to the
    /// device list with an explanation when that fails.
    /// </summary>
    /// <summary>
    /// Record which computer the user connected to last, so the "auto connect"
    /// start behaviour has a target.
    /// </summary>
    /// <remarks>
    /// The decision itself lives in <see cref="StartupBehavior"/> so it can be tested
    /// without a window; this only supplies the current settings and data folder.
    /// </remarks>
    private void RememberLastDevice(SavedDevice device)
    {
        if (StartupBehavior.RememberLastDevice(_settings, DataRoot, device))
            Log("last device recorded: " + device.ShortId);
    }

    /// <summary>Stamp "last connected" so the device list can show a relative time.</summary>
    private void MarkConnected(SavedDevice device)
    {
        _store.MarkConnected(device.EndpointId,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Log);
    }

    private async Task AutoConnectOnLaunchAsync()
    {
        if (!_dataWritable) return; // nothing was persisted, so there is nothing to reconnect
        var target = StartupBehavior.SelectAutoConnectTarget(
            _settings.StartPage, _store.All, _settings.LastDeviceEndpointId);
        if (target is null) return;
        _autoConnecting = true;
        try
        {
            await ConnectToAsync(target, null, null);
        }
        finally
        {
            _autoConnecting = false;
        }
    }

    /// <summary>Show the settings page, keeping the device list state intact.</summary>
    private void SettingsOpen_Click(object sender, RoutedEventArgs e) => ShowSettingsPage(true);
    /// <summary>Return to the device list from either the rail or the page header.</summary>
    /// <summary>
    /// Reflect the active surface in the navigation rail.
    /// </summary>
    /// <remarks>
    /// The rail is a RadioButton group and the RailItem template draws the accent pill and
    /// marker from <c>IsChecked</c>, which is also what a screen reader reports. Every path
    /// that switches the main surface must call this: Settings is the only destination with
    /// its own page, so the connecting page and the embedded browser both count as Devices.
    /// </remarks>
    private void SyncRail(bool settingsSelected)
    {
        SettingsRailButton.IsChecked = settingsSelected;
        DevicesRailButton.IsChecked = !settingsSelected;
    }

    private void SettingsBack_Click(object sender, RoutedEventArgs e) => ShowSettingsPage(false);

    private void ShowSettingsPage(bool show)
    {
        DevicesScroll.Visibility = show ? Visibility.Collapsed : Visibility.Visible;
        SettingsScroll.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        SyncRail(show);
        if (show) SyncSettingsControls();
        else RefreshDeviceList();
    }

    /// <summary>Push the stored preferences into the controls that display them.</summary>
    private void SyncSettingsControls()
    {
        ApplyAppIcon();
        ThemeSystem.IsChecked = _settings.Theme == "system";
        ThemeLight.IsChecked = _settings.Theme == "light";
        ThemeDark.IsChecked = _settings.Theme == "dark";
        StartDevices.IsChecked = _settings.StartPage == AppSettings.StartPageDevices;
        StartLast.IsChecked = _settings.StartPage == AppSettings.StartPageLastDevice;
        NotifyToggle.IsChecked = _settings.BackgroundNotifications;
        SyncLanguageControls();
    }

    private void Theme_Checked(object sender, RoutedEventArgs e)
    {
        // Checked fires while the XAML is still being built; ignore until loaded.
        if (_settings is null) return;
        _settings.Theme = ThemeDark.IsChecked == true ? "dark"
            : ThemeLight.IsChecked == true ? "light" : "system";
        _settings.Save(DataRoot);
        (Application.Current as App)?.ApplyThemePreference(_settings.Theme);
    }

    private void StartPage_Checked(object sender, RoutedEventArgs e)
    {
        if (_settings is null) return;
        _settings.StartPage = StartLast.IsChecked == true
            ? AppSettings.StartPageLastDevice : AppSettings.StartPageDevices;
        _settings.Save(DataRoot);
    }

    private void Notify_Click(object sender, RoutedEventArgs e)
    {
        if (_settings is null) return;
        _settings.BackgroundNotifications = NotifyToggle.IsChecked == true;
        _settings.Save(DataRoot);
        // Turning the switch off stops an active watcher immediately; the connected
        // page keeps working, only the notifications stop.
        if (!_settings.BackgroundNotifications) StopTaskWatcher();
        else if (_current is not null && _watcher is null) Log("notifications re-enabled; reconnect to start the watcher");
    }

    private async void ClearSiteData_Click(object sender, RoutedEventArgs e)
    {
        if (_core is null)
        {
            MessageBox.Show(Strings.Settings_ClearNeedConnect, Strings.Settings_ClearSiteData,
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var confirm = MessageBox.Show(
            Strings.Settings_ClearConfirm,
            Strings.Settings_ClearSiteData, MessageBoxButton.OKCancel, MessageBoxImage.Warning);
        if (confirm != MessageBoxResult.OK) return;
        try
        {
            await _core.Profile.ClearBrowsingDataAsync();
            Log("site data cleared");
            MessageBox.Show(Strings.Settings_ClearDone, Strings.Settings_ClearSiteData,
                MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception error)
        {
            Log("site data clear failed: " + error);
            MessageBox.Show(string.Format(Strings.Settings_ClearFailed, error.Message),
                Strings.Settings_ClearSiteData,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void ShowAddPanel(bool show)
    {
        AddPanel.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        AddToggleButton.Content = show ? Strings.DeviceList_Collapse : Strings.DeviceList_AddComputer;
    }

    /// <summary>
    /// Centre the empty state in the space below the fixed header instead of leaving it
    /// stuck to the top over two thirds of blank window; a populated list stays at the
    /// top, where the section header's rhythm expects it.
    /// </summary>
    /// <remarks>
    /// The body's height is at least one viewport (bound in XAML), so a centred child
    /// can use the whole page. Nothing is stretched: the cards keep their own height and
    /// only the space around them changes.
    /// </remarks>
    private void SyncDevicePageLayout() =>
        DevicesContent.VerticalAlignment = NoDevicesText.Visibility == Visibility.Visible
            ? VerticalAlignment.Center
            : VerticalAlignment.Top;

    private void AddToggle_Click(object sender, RoutedEventArgs e) =>
        ShowAddPanel(AddPanel.Visibility != Visibility.Visible);

    private async void Pair_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var input = DescriptorBox.Text.Trim();
        SavedDevice device;
        string? irohCode = null, gatewayToken = null;
        try
        {
            // The iroh JSON descriptor and the URL-form LAN/remote link are distinct
            // formats; try the JSON contract first, then the pairing URL.
            var descriptor = PairingDescriptor.Parse(input);
            device = SavedDevice.FromDescriptor(descriptor);
            irohCode = descriptor.IrohCode;
            gatewayToken = descriptor.GatewayToken;
        }
        catch (Exception irohError)
        {
            try
            {
                var link = UrlPairing.Parse(input);
                if (_pendingAdopt is not null)
                {
                    // Address follow: the new link must come from the same
                    // computer; the name is kept, the token is re-paired.
                    if (link.InstanceId != _pendingAdopt.InstanceId)
                    {
                        MessageBox.Show(this,
                            Strings.Pairing_UpdateAddressNotSame,
                            Strings.Pairing_UpdateAddressTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
                        return;
                    }
                    device = _pendingAdopt.AdoptNewOrigin(link);
                    _pendingAdopt = null;
                    gatewayToken = link.Token;
                    Log($"adopting moved gateway: channel={link.Mode} requiresCa={link.RequiresCa}");
                }
                else
                {
                    if (_selectedDiscovery is not null && link.Origin != _selectedDiscovery.Origin)
                    {
                        var confirm = MessageBox.Show(this,
                            string.Format(Strings.Pairing_OriginMismatch,
                                link.Origin, _selectedDiscovery.Origin),
                            Strings.Pairing_OriginMismatchTitle,
                            MessageBoxButton.YesNo, MessageBoxImage.Warning);
                        if (confirm != MessageBoxResult.Yes) return;
                    }
                    _selectedDiscovery = null;
                    device = SavedDevice.FromUrlPairing(link);
                    gatewayToken = link.Token;
                    Log($"url pairing link: channel={link.Mode} requiresCa={link.RequiresCa}");
                }
            }
            catch (Exception urlError)
            {
                Log($"descriptor rejected: iroh={irohError.Message} url={urlError.Message}");
                MessageBox.Show(this,
                    string.Format(Strings.Pairing_InvalidContent,
                        irohError.Message, urlError.Message),
                    Strings.Pairing_InvalidContentTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
        }
        DescriptorBox.Text = string.Empty; // one-time secrets never stay in the UI
        await ConnectToAsync(device, irohCode, gatewayToken);
    }

    /// <summary>
    /// UDP announcements first, then a bounded /24 probe per local IPv4, the
    /// same order Android uses. Picking a result only records which computer
    /// the pasted link must point at; pairing still needs its one-time link.
    /// </summary>
    private async void ScanButton_Click(object sender, RoutedEventArgs e)
    {
        if (_scanning || _busy) return;
        _scanning = true;
        SetScanButtons(false);
        FoundList.Children.Clear();
        _selectedDiscovery = null;
        DiscoveryHint.Visibility = Visibility.Collapsed;
        _scanCts = new CancellationTokenSource();
        _scanCts.CancelAfter(TimeSpan.FromSeconds(20));
        var token = _scanCts.Token;
        var found = new Dictionary<string, DiscoveredGateway>(StringComparer.Ordinal);
        try
        {
            await foreach (var gateway in LanDiscovery.QueryAsync(
                LanDiscovery.DefaultPort, TimeSpan.FromSeconds(4), Log, token))
            {
                if (found.TryAdd(gateway.InstanceId, gateway)) AddFoundCard(gateway);
            }
            if (found.Count == 0)
            {
                ShowDiscoveryHint(Strings.Pairing_ScanNoBroadcast);
                foreach (var local in LocalIPv4s())
                {
                    await foreach (var gateway in LanDiscovery.ScanSubnetAsync(
                        local, LanDiscovery.DefaultPort, TimeSpan.FromSeconds(2), Log, token))
                    {
                        if (found.TryAdd(gateway.InstanceId, gateway)) AddFoundCard(gateway);
                    }
                    if (found.Count > 0) break;
                }
            }
            if (found.Count == 0)
                ShowDiscoveryHint(Strings.Pairing_ScanNotFound);
            else
                Log($"discovery found {found.Count} computer(s)");
        }
        catch (OperationCanceledException)
        {
            if (found.Count == 0) ShowDiscoveryHint(Strings.Pairing_ScanTimeout);
        }
        catch (Exception error)
        {
            Log("discovery scan failed: " + error.Message);
            ShowDiscoveryHint(string.Format(Strings.Pairing_ScanFailed, error.Message));
        }
        finally
        {
            _scanning = false;
            SetScanButtons(true);
        }
    }

    private async void ProbeButton_Click(object sender, RoutedEventArgs e)
    {
        if (_scanning || _busy) return;
        string host;
        int port;
        try
        {
            (host, port) = LanDiscovery.NormalizeManualInput(AddressBox.Text);
        }
        catch (FormatException error)
        {
            MessageBox.Show(this, string.Format(Strings.Pairing_InvalidAddress, error.Message),
                Strings.Pairing_FindTitle,
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        _scanning = true;
        SetScanButtons(false);
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var gateway = await LanDiscovery.ProbeAsync(host, port, cts.Token);
            FoundList.Children.Clear();
            AddFoundCard(gateway);
            SelectDiscovery(gateway);
            Log($"probed gateway: {gateway.DeviceName} {gateway.Origin}");
        }
        catch (Exception error)
        {
            Log("probe failed: " + error.Message);
            MessageBox.Show(this, string.Format(Strings.Pairing_GatewayNotFound, error.Message),
                Strings.Pairing_FindTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            _scanning = false;
            SetScanButtons(true);
        }
    }

    private void SelectDiscovery_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button button && button.Tag is DiscoveredGateway gateway)
            SelectDiscovery(gateway);
    }

    private void SelectDiscovery(DiscoveredGateway gateway)
    {
        _selectedDiscovery = gateway;
        ShowDiscoveryHint(string.Format(Strings.Pairing_SelectedHint,
            gateway.DeviceName, gateway.Origin));
    }

    private void AddFoundCard(DiscoveredGateway gateway)
    {
        var info = new TextBlock
        {
            Text = $"{gateway.DeviceName}\n{gateway.Origin}",
            FontSize = 13,
            TextWrapping = TextWrapping.Wrap,
        };
        info.SetResourceReference(TextBlock.ForegroundProperty, "PrimaryTextBrush");
        var select = new Button
        {
            Content = Strings.Pairing_SelectFound, Width = 80,
            Margin = new Thickness(12, 0, 0, 0), Tag = gateway,
            ToolTip = Strings.Pairing_SelectFoundTooltip,
        };
        select.Click += SelectDiscovery_Click;
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(info);
        grid.Children.Add(select);
        Grid.SetColumn(select, 1);
        var card = new Border
        {
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(14),
            Margin = new Thickness(0, 0, 0, 8),
            Child = grid,
        };
        card.SetResourceReference(Border.BackgroundProperty, "CardBrush");
        card.SetResourceReference(Border.BorderBrushProperty, "CardBorderGradientBrush");
        FoundList.Children.Add(card);
    }

    private void ShowDiscoveryHint(string text)
    {
        DiscoveryHint.Text = text;
        DiscoveryHint.Visibility = Visibility.Visible;
    }

    private void SetScanButtons(bool enabled)
    {
        ScanButton.IsEnabled = enabled;
        ProbeButton.IsEnabled = enabled;
        ScanButton.Content = enabled ? Strings.Pairing_Scan : Strings.Pairing_ScanRunning;
    }

    private static IEnumerable<string> LocalIPv4s()
    {
        try
        {
            return Dns.GetHostAddresses(Dns.GetHostName())
                .Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork &&
                            !IPAddress.IsLoopback(a))
                .Select(a => a.ToString())
                .Distinct()
                .ToList();
        }
        catch
        {
            return [];
        }
    }

    private async void ConnectSaved_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var device = (SavedDevice)((Button)sender).Tag;
        if (!device.CanReconnect || device.GetDeviceToken() is null)
        {
            ShowAddPanel(true);
            DescriptorBox.Focus();
            _pendingAdopt = device;
            MessageBox.Show(this, Strings.Pairing_ReneedBody,
                Strings.Pairing_ReneedTitle, MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        await ConnectToAsync(device, null, null);
    }

    // Deletion is handled by DeleteDevice in MainWindow.Devices.cs: it removes the
    // record without a modal (the undo strip replaces the confirmation) and leaves a
    // live session running.

    private void RenameDevice_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        // Reached from the row menu, so the sender is a MenuItem, not a Button.
        // Both are FrameworkElements and carry the device in Tag.
        if ((sender as FrameworkElement)?.Tag is not SavedDevice device) return;
        var dialog = new RenameDialog(device.Name) { Owner = this };
        if (dialog.ShowDialog() != true) return;
        _store.Rename(device.EndpointId, dialog.DeviceName, Log);
        RefreshDeviceList();
        if (_current?.EndpointId == device.EndpointId)
        {
            _current.Name = dialog.DeviceName;
            BrowserTitle.Text = string.Format(Strings.Connect_Connected, dialog.DeviceName);
            if (_carrier is not null) Title = "DeepSeek Harness — " + dialog.DeviceName;
        }
        Log($"renamed saved device {device.EndpointId} -> {dialog.DeviceName}");
    }

    /// <summary>
    /// pairingCode != null: first-time iroh pairing (Wire::Pair + native-pair).
    /// gatewayToken without irohCode: URL-form pairing (direct HTTPS + native-pair).
    /// Both null: reconnect a saved device (iroh Hello or direct native-renew).
    /// </summary>
    private async Task ConnectToAsync(SavedDevice device, string? pairingCode, string? gatewayToken)
    {
        var isIroh = device.Channel == "iroh";
        // Returning to the device list keeps the live session. Reconnecting to the
        // same host should just reveal the page, not start a second sidecar on 25443.
        var live = _current?.EndpointId == device.EndpointId &&
                   (!isIroh || _carrier is not null) &&
                   (isIroh || _core is not null);
        if (live && pairingCode is null)
        {
            ShowBrowserPage(device);
            Log("already connected to this device; returning to the page");
            return;
        }
        DisconnectCore(); // release the local proxy port before a new sidecar binds it
        _busy = true;
        _userCancelled = false;
        _connectCts = new CancellationTokenSource();
        _connectCts.CancelAfter(TimeSpan.FromSeconds(120));
        _irohDiagnostics = string.Empty;
        Log($"connect target: {device.InstanceId[..12]}… channel={device.Channel} " +
            $"mode={(pairingCode is not null ? "iroh-pair" : gatewayToken is not null ? "url-pair" : "renew")}");
        try
        {
            NativeSession session;
            if (isIroh)
            {
                SetProgress(Strings.Connect_ConnectingIroh);
                var carrier = await StartCarrierWithRetryAsync(device, pairingCode, _connectCts.Token);
                _carrier = carrier;
                carrier.Failed += reason =>
                {
                    Log(reason);
                    try
                    {
                        Dispatcher.BeginInvoke(new Action(() =>
                        {
                            if (_carrier is null) return;
                            SetProgress(Strings.Connect_Interrupted);
                            // The progress line lives on the connect page, which is
                            // hidden while the user is reading the page. The bar stays
                            // visible, so the disconnect has to show up there too.
                            BrowserTitle.Text = string.Format(Strings.Connect_InterruptedTitle, device.Name);
                            if (_settings.BackgroundNotifications)
                                ShowTrayBalloon(Strings.Connect_Interrupted, reason, System.Windows.Forms.ToolTipIcon.Warning);
                        }));
                    }
                    catch { /* window closed */ }
                };
                Log("iroh transport ready: " + carrier.ProxyOrigin);
                session = await AuthorizeAsync(device, pairingCode, gatewayToken);
            }
            else
            {
                SetProgress(Strings.Connect_VerifyingComputer);
                if (gatewayToken is not null && !device.HasPinnedCa)
                {
                    var ca = await GatewayAuth.FetchCaAsync(device, _connectCts.Token);
                    if (ca is not null)
                    {
                        device.CaDerBase64 = Convert.ToBase64String(ca.RawData);
                        Log("pairing CA bootstrapped from /mobile-access/ca.cer and pinned");
                    }
                    else
                    {
                        device.PlatformTrust = true;
                        // FetchCaAsync only returns null when PairingTrustPolicy allows it:
                        // an explicit 404 for a public-CA remote key (dsh1 / legacy).
                        Log("gateway answered 404 for ca.cer; using platform trust (public-CA remote key)");
                    }
                }
                session = await AuthorizeAsync(device, pairingCode, gatewayToken);
            }

            SetProgress(Strings.Connect_LoadingPage);
            var webViewTask = EnsureWebViewAsync();
            var webViewTimeout = Task.Delay(TimeSpan.FromSeconds(25), _connectCts.Token);
            if (await Task.WhenAny(webViewTask, webViewTimeout) != webViewTask)
                throw new TimeoutException("WebView2 init timed out");
            await webViewTask;

            // WebView2 cannot report which certificate a response used and only raises
            // its error event when Chromium's own validation fails, so verify the pin
            // over a real handshake before handing the origin to the browser.
            if (!await VerifyPinnedOriginAsync(device, _connectCts.Token, Log))
                throw new InvalidOperationException(Strings.Connect_PinnedCertVerifyFailed);
            _current = device;
            InstallCookies(session);
            await ClearCachedCertificateDecisionsAsync();
            ShowBrowserPage(device);
            _core!.Navigate(device.Origin);
            Log("connected: " + device.Origin);
            RememberLastDevice(device);
            MarkConnected(device);
            StartTaskWatcher(device, session);
        }
        catch (Exception error)
        {
            if (_userCancelled)
            {
                // Cancellation is a user action, not a failure - no warning dialog.
                Log("connect cancelled by user");
                DisconnectCore();
                ShowConnectPage();
                return;
            }
            Log("connect failed: " + error);
            var (hint, repair) = BuildHint(error, _irohDiagnostics, device);
            DisconnectCore();
            ShowConnectPage();
            if (repair) { ShowAddPanel(true); DescriptorBox.Focus(); }
            SetProgress(string.Empty);
            if (_autoConnecting) hint = StartupBehavior.DescribeAutoConnectFailure(hint, device.Name);
            if (repair && IsAdoptableFailure(error, device))
            {
                // The gateway may have moved (rotated tunnel address) or the
                // credential expired: offer to paste the computer's current
                // link and keep the saved name.
                var update = MessageBox.Show(this,
                    string.Format(Strings.Connect_OfferAdopt, hint),
                    Strings.Connect_FailedTitle, MessageBoxButton.YesNo, MessageBoxImage.Warning);
                if (update == MessageBoxResult.Yes)
                {
                    _pendingAdopt = device;
                    ShowAddPanel(true);
                    DescriptorBox.Focus();
                    return;
                }
                return;
            }
            MessageBox.Show(this, hint, Strings.Connect_FailedTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        finally
        {
            _busy = false;
            SetBusyButtons(false);
        }
    }

    /// <summary>Shared Gateway auth for both transports; saves the device credential on pairing.</summary>
    private async Task<NativeSession> AuthorizeAsync(SavedDevice device, string? pairingCode, string? gatewayToken)
    {
        SetProgress(Strings.Connect_Authorizing);
        if (pairingCode is not null && gatewayToken is not null ||
            device.Channel != "iroh" && gatewayToken is not null)
        {
            var session = await GatewayAuth.PairAsync(device, gatewayToken!, _connectCts!.Token);
            device.DeviceId = session.DeviceId;
            device.DeviceExpiresAt = session.DeviceExpiresAt;
            device.SetDeviceToken(session.DeviceToken);
            _store.Upsert(device, Log);
            Log("saved paired device (deviceToken sealed with DPAPI)");
            return session;
        }
        var token = device.GetDeviceToken()
            ?? throw new InvalidOperationException(Strings.Connect_CredentialUnavailable);
        var renewed = await GatewayAuth.RenewAsync(device, token, _connectCts!.Token);
        Log("session renewed without a QR code");
        return renewed;
    }

    private (string Hint, bool Repair) BuildHint(Exception error, string diagnostics, SavedDevice device)
    {
        var failure = ConnectionDiagnosis.Diagnose(error, diagnostics,
            new ConnectionTarget(device.Channel, device.Hostname));
        if (failure.Kind is ConnectionFailureKind.CredentialExpired or ConnectionFailureKind.ProtocolMismatch
            or ConnectionFailureKind.CaMismatch)
        {
            var prefix = device.ShortId;
            return (failure.Hint + string.Format(Strings.Connect_InstanceSuffix, prefix), failure.Repair);
        }
        return (failure.Hint, failure.Repair);
    }

    /// <summary>
    /// Direct (lan/remote) failures worth offering an address update for:
    /// the gateway moved or the credential expired/revoked. iroh records
    /// carry their own endpoint identity and reconnect via Hello instead.
    /// </summary>
    private static bool IsAdoptableFailure(Exception error, SavedDevice device) =>
        ConnectionDiagnosis.IsAdoptable(error, new ConnectionTarget(device.Channel, device.Hostname));

    private void SetProgress(string status)
    {
        StatusText.Text = status;
        Title = string.IsNullOrEmpty(status) ? "DeepSeek Harness" : "DeepSeek Harness — " + status;
        var busy = !string.IsNullOrEmpty(status);
        ProgressPanel.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        // Reduced motion: keep the text status, drop the indeterminate animation.
        Progress.Visibility = App.MotionEnabled ? Visibility.Visible : Visibility.Collapsed;
        if (busy)
        {
            CancelButton.IsEnabled = true;
            if (App.MotionEnabled)
                StatusText.BeginAnimation(OpacityProperty,
                    new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
        }
        else
        {
            StatusText.BeginAnimation(OpacityProperty, null);
            StatusText.Opacity = 1;
        }
        SetBusyButtons(busy);
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        if (_connectCts is null) return;
        _userCancelled = true;
        Log("user requested cancellation");
        CancelButton.IsEnabled = false;
        _connectCts.Cancel();
    }

    private void SetBusyButtons(bool busy)
    {
        foreach (var button in _connectButtons) button.IsEnabled = !busy;
        AddToggleButton.IsEnabled = !busy;
        PairButton.IsEnabled = !busy;
    }

    private async Task<IrohCarrier> StartCarrierWithRetryAsync(
        SavedDevice device, string? pairingCode, CancellationToken ct)
    {
        // The sidecar is not bundled: acquire the pinned official artifact (verified
        // by byte count + SHA-256) once before the retry loop starts.
        SetProgress(Strings.Connect_PreparingIroh);
        var sidecarPath = await SidecarProvisioner.EnsureAsync(DataRoot, Log, ct);
        for (var attempt = 1; ; attempt++)
        {
            var carrier = new IrohCarrier(sidecarPath);
            carrier.Log += Log;
            try
            {
                await carrier.StartAsync(device, pairingCode, IdentityDir, ct);
                return carrier;
            }
            catch (Exception error)
            {
                _irohDiagnostics = carrier.Diagnostics;
                var transient = attempt < MaxConnectAttempts
                    && !ct.IsCancellationRequested
                    && IsTransientDiscoveryFailure(_irohDiagnostics, error);
                carrier.Dispose();
                if (!transient) throw;
                Log($"iroh attempt {attempt}/{MaxConnectAttempts} failed ({error.Message}); retrying with a fresh Endpoint");
                SetProgress(string.Format(Strings.Connect_Retrying, attempt + 1, MaxConnectAttempts));
            }
        }
    }

    private static bool IsTransientDiscoveryFailure(string diagnostics, Exception error)
    {
        if (error is not IOException) return false;
        if (diagnostics.Contains("pair", StringComparison.OrdinalIgnoreCase)) return false;
        return diagnostics.Contains("host connection timed out", StringComparison.OrdinalIgnoreCase)
            || diagnostics.Contains("No addressing information available", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Confirm over a real handshake that this origin still presents a certificate
    /// signed by the pairing CA.
    /// </summary>
    /// <remarks>
    /// WebView2 raises <c>ServerCertificateErrorDetected</c> only when Chromium's own
    /// validation fails, and it exposes no way to read the certificate a response used.
    /// A certificate the platform already trusts — an enterprise TLS-inspection root, or
    /// a public CA for a tunnel hostname that was reassigned — therefore reaches the
    /// page without the pinned CA ever being checked. This probe performs the same
    /// handshake the browser is about to do and applies the pin itself, so a mismatch
    /// stops the connection instead of silently loading a page under the wrong anchor.
    /// Platform-trust devices keep Chromium's verdict, which is their contract.
    /// </remarks>
    private static async Task<bool> VerifyPinnedOriginAsync(SavedDevice device, CancellationToken token, Action<string> log)
    {
        if (!device.HasPinnedCa) return true;
        try
        {
            if (!Uri.TryCreate(device.Origin, UriKind.Absolute, out var origin) || origin.Port <= 0) return false;
            // Probe the address the transport will actually use, not a DNS answer:
            // an iroh row's hostname is a synthetic *.iroh.localhost identity that
            // only the sidecar's loopback proxy answers for, and Windows DNS does
            // not resolve it — asking DNS sent the probe to whatever a resolver
            // returned and made every iroh connection fail with a security warning.
            // The TLS server name still comes from the hostname below.
            var address = device.Channel == "iroh" ? IPAddress.Loopback : null;
            if (address is null)
            {
                var addresses = await Dns.GetHostAddressesAsync(device.Hostname, token);
                address = addresses.FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork)
                    ?? addresses.FirstOrDefault();
            }
            if (address is null) return false;
            using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            await socket.ConnectAsync(address, origin.Port, token);
            using var network = new NetworkStream(socket, ownsSocket: false);
            using var ssl = new SslStream(network, leaveInnerStreamOpen: false);
            var observed = (X509Certificate2?)null;
            var options = new SslClientAuthenticationOptions
            {
                TargetHost = device.Hostname,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                // The pin replaces the platform chain, exactly as the data path does.
                RemoteCertificateValidationCallback = (_, certificate, _, _) =>
                {
                    if (certificate is null) return false;
                    observed = new X509Certificate2(certificate);
                    return CertificatePolicy.ValidateLeaf(observed, device.Ca, device.Hostname);
                },
            };
            await ssl.AuthenticateAsClientAsync(options, token);
            observed?.Dispose();
            return true;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            log("pinned-origin probe failed: " + error.GetType().Name);
            return false;
        }
    }

    private void ShowBrowserPage(SavedDevice device)
    {
        WebView.Visibility = Visibility.Visible;
        ConnectPage.Visibility = Visibility.Collapsed;
        SyncRail(false);
        Title = "DeepSeek Harness — " + device.Name;
        BrowserTitle.Text = string.Format(Strings.Connect_Connected, device.Name);
        BackButton.Visibility = Visibility.Visible;
        BrowserTitle.Visibility = Visibility.Visible;
        DisconnectButton.Visibility = Visibility.Visible;
        SetProgress(string.Empty);
        SetBusyButtons(false);
    }

    private void ShowConnectPage()
    {
        ConnectPage.Visibility = Visibility.Visible;
        WebView.Visibility = Visibility.Collapsed;
        SyncRail(false);
        BackButton.Visibility = Visibility.Collapsed;
        BrowserTitle.Visibility = Visibility.Collapsed;
        DisconnectButton.Visibility = Visibility.Collapsed;
        Title = "DeepSeek Harness";
        SetProgress(string.Empty);
        RefreshDeviceList();
    }


    private void Back_Click(object sender, RoutedEventArgs e) => ShowConnectPage();

    private async void Disconnect_Click(object sender, RoutedEventArgs e)
    {
        DisconnectAsyncCore();
        await ClearCachedCertificateDecisionsAsync();
        ShowConnectPage();
        Log("disconnected");
    }

    private void DisconnectAsyncCore()
    {
        DisconnectCore();
        if (_core is null) return;
        _core.Navigate("about:blank");
        try { _core.CookieManager.DeleteAllCookies(); }
        catch (Exception error) { Log("cookie clear failed: " + error.Message); }
    }

    private async Task InitializeWebViewAsync()
    {
        try { await EnsureWebViewAsync(); }
        catch (Exception error) { Log("WebView2 early init failed (will retry on connect): " + error.Message); }
        // Only now is the native HWND safe to collapse: it has a live CoreWebView2.
        ShowConnectPage();
    }

    private async Task EnsureWebViewAsync()
    {
        if (_core is not null) return;
        // Chromium reports a generic init timeout when the runtime is absent, which
        // reads as a network problem. Ask the loader directly so the user is told
        // what to install instead.
        if (WebView2Availability.Detect(() => CoreWebView2Environment.GetAvailableBrowserVersionString()) is null)
            throw new InvalidOperationException(WebView2Availability.MissingMessage);
        await _webViewGate.WaitAsync();
        var previousVisibility = WebView.Visibility;
        try
        {
            if (_core is not null) return;
            WebView.Visibility = Visibility.Visible; // native HWND needs a real size to initialise
            Directory.CreateDirectory(WebViewProfile);
            // Windows DNS does not resolve *.iroh.localhost, and Chromium may prefer ::1
            // while the sidecar only binds 127.0.0.1.
            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = "--host-resolver-rules=MAP *.iroh.localhost 127.0.0.1",
            };
            var environment = await CoreWebView2Environment.CreateAsync(null, WebViewProfile, options);
            await WebView.EnsureCoreWebView2Async(environment);
            _core = WebView.CoreWebView2;
            if (!_certificateHandlerAttached)
            {
                _core.ServerCertificateErrorDetected += OnServerCertificateError;
                AttachWebViewPolicyHandlers();
                _certificateHandlerAttached = true;
            }
            _core.Settings.AreDevToolsEnabled = false;
            Log("WebView2 ready (isolated user data folder)");
        }
        finally
        {
            if (_core is null && previousVisibility == Visibility.Collapsed)
                WebView.Visibility = previousVisibility; // keep the connect page usable
            _webViewGate.Release();
        }
    }

    /// <summary>
    /// Conservative WebView2 surface policy. The Android app owns explicit rules for
    /// navigation, external links, downloads and permissions (SecureWebViewClient,
    /// GatewayUrlPolicy, MainActivity); without these handlers every one of those
    /// behaviors is undefined on Windows. Only the exact paired gateway origin may
    /// navigate; pop-ups stay blocked, downloads are saved through a same-origin
    /// file dialog, and only the microphone is granted (camera and the rest are
    /// denied). A renderer crash is reported and recovered with a reload.
    /// </summary>
    private void AttachWebViewPolicyHandlers()
    {
        var core = _core!;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.DownloadStarting += OnDownloadStarting;
        core.PermissionRequested += OnPermissionRequested;
        core.ProcessFailed += OnProcessFailed;
    }

    private bool IsAllowedGatewayNavigation(string raw)
    {
        if (raw == "about:blank") return true; // used when disconnecting
        return _current is not null && WebViewPolicy.IsSameGatewayOrigin(raw, _current.Origin);
    }

    private static bool IsExternalHttps(string raw) =>
        Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps;

    private static string SuggestedDownloadName(string raw)
    {
        try
        {
            var name = Path.GetFileName(new Uri(raw, UriKind.Absolute).LocalPath.TrimEnd('/'));
            if (!string.IsNullOrWhiteSpace(name) && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0)
                return name;
        }
        catch { /* fall through to the default */ }
        return "download";
    }

    private void OpenInSystemBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            Log("opened external link in the system browser");
        }
        catch (Exception error) { Log("could not open external link: " + error.Message); }
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsAllowedGatewayNavigation(e.Uri)) return;
        e.Cancel = true;
        Log("blocked navigation outside the paired gateway: " + e.Uri);
        if (IsExternalHttps(e.Uri)) OpenInSystemBrowser(e.Uri);
        else NotifyPolicyOnce("navigation", Strings.WebView_BlockedNavigation);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        Log("blocked new window: " + e.Uri);
        if (IsExternalHttps(e.Uri)) OpenInSystemBrowser(e.Uri);
        else NotifyPolicyOnce("popup", Strings.WebView_BlockedPopup);
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        // Android allows foreground downloads from the exact paired origin;
        // anything else stays cancelled.
        if (_current is not null && WebViewPolicy.IsSameGatewayOrigin(e.DownloadOperation.Uri, _current.Origin))
        {
            var suggested = SuggestedDownloadName(e.DownloadOperation.Uri);
            var dialog = new Microsoft.Win32.SaveFileDialog { FileName = suggested };
            if (dialog.ShowDialog(this) == true)
            {
                e.ResultFilePath = dialog.FileName;
                e.Handled = true;
                Log("download allowed to a chosen path from the paired gateway");
                return;
            }
            e.Cancel = true;
            e.Handled = true;
            Log("download cancelled by the user");
            return;
        }
        e.Cancel = true;
        e.Handled = true;
        Log("blocked off-origin download: " + e.DownloadOperation.Uri);
        NotifyPolicyOnce("download", Strings.WebView_BlockedDownload);
    }

    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        // DSH records audio through getUserMedia and the computer's own voice
        // provider; like Android, the paired origin may use the microphone.
        // Camera and everything else stay denied.
        if (e.PermissionKind == CoreWebView2PermissionKind.Microphone &&
            _current is not null && WebViewPolicy.IsSameGatewayOrigin(e.Uri, _current.Origin))
        {
            e.State = CoreWebView2PermissionState.Allow;
            Log("allowed microphone for the paired gateway");
            return;
        }
        e.State = CoreWebView2PermissionState.Deny;
        Log("denied permission: " + e.PermissionKind);
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log($"WebView2 process failed: {e.ProcessFailedKind} (exit {e.ExitCode})");
        // A renderer/frame crash can be reloaded; a browser process exit cannot.
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            NotifyPolicyOnce("browser-exit", Strings.WebView_BrowserExited);
            return;
        }
        try
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                if (_core is null || _current is null) return;
                NotifyPolicyOnce("renderer-reload", Strings.WebView_RendererReloading);
                _core.Reload();
            }));
        }
        catch (Exception error) { Log("renderer reload failed: " + error.Message); }
    }

    private readonly HashSet<string> _shownPolicyNotices = [];

    /// <summary>Show each policy notice at most once per session; never spam a dialog.</summary>
    private void NotifyPolicyOnce(string key, string message)
    {
        if (!_shownPolicyNotices.Add(key)) return;
        try
        {
            Dispatcher.BeginInvoke(new Action(() =>
                MessageBox.Show(this, message, Strings.WebView_NoticeTitle, MessageBoxButton.OK, MessageBoxImage.Information)));
        }
        catch { /* window closed */ }
    }

    /// <summary>
    /// The pairing CA is the only trust anchor, so Chromium's system-chain verdict is
    /// not authoritative. Only a leaf chaining to that exact CA with a matching SAN,
    /// EKU and validity may proceed. Expired/revoked verdicts are never overridden.
    /// </summary>
    private void OnServerCertificateError(object? sender, CoreWebView2ServerCertificateErrorDetectedEventArgs e)
    {
        var definitive = e.ErrorStatus is CoreWebView2WebErrorStatus.CertificateExpired
            or CoreWebView2WebErrorStatus.CertificateRevoked;
        // A platform-trust device (dsh1 remote without a pairing CA) relies on
        // Chromium's own validation, so any error event is rejected, never overridden.
        var allowed = _current is not null
            && !definitive
            && _current.HasPinnedCa
            && CertificatePolicy.ValidateLeaf(
                e.ServerCertificate?.ToX509Certificate2(), _current.Ca, _current.Hostname);
        e.Action = allowed
            ? CoreWebView2ServerCertificateErrorAction.AlwaysAllow
            : CoreWebView2ServerCertificateErrorAction.Cancel;
        Log($"certificate error {e.ErrorStatus}: {(allowed ? "allowed for pinned CA" : "rejected")}");
    }

    private void InstallCookies(NativeSession session)
    {
        var manager = _core!.CookieManager;
        var host = _current!.Hostname;
        foreach (var (name, httpOnly) in new[]
        {
            ("dsh_ma_session", true),
            ("dsh_ma_csrf", false),
            ("__Host-dsh_ma_session", true),
            ("__Host-dsh_ma_csrf", false),
        })
        {
            var value = name.EndsWith("csrf", StringComparison.Ordinal) ? session.CsrfToken : session.SessionToken;
            var cookie = manager.CreateCookie(name, value, host, "/");
            cookie.IsSecure = true;
            cookie.IsHttpOnly = httpOnly;
            cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
            cookie.Expires = DateTimeOffset.FromUnixTimeMilliseconds(session.SessionExpiresAt).UtcDateTime;
            manager.AddOrUpdateCookie(cookie);
        }
        Log("session cookies installed for " + host);
    }

    private async Task ClearCachedCertificateDecisionsAsync()
    {
        if (_core is null) return;
        try { await _core.ClearServerCertificateErrorActionsAsync(); }
        catch (Exception error) { Log("certificate cache clear failed: " + error.Message); }
    }

    private void DisconnectCore()
    {
        _connectCts?.Cancel();
        _connectCts?.Dispose();
        _connectCts = null;
        StopTaskWatcher();
        _carrier?.Dispose();
        _carrier = null;
        _current = null;
    }

    /// <summary>
    /// Follows the same background-events stream the Android dataSync service
    /// consumes, so task completions surface as desktop balloons while the
    /// window is minimized. Closing the app still stops notifications: the
    /// tray icon is only visible while the watcher runs.
    /// </summary>
    private void StartTaskWatcher(SavedDevice device, NativeSession session)
    {
        // The settings page can switch notifications off; a watcher that still ran
        // would keep a tray icon alive for notifications the user declined.
        if (!_settings.BackgroundNotifications)
        {
            Log("task watcher disabled by preference");
            return;
        }
        StopTaskWatcher();
        var watcher = new BackgroundEventWatcher(device, RenewForWatcherAsync, Log);
        watcher.TaskNotified += (title, body) => Dispatcher.BeginInvoke(new Action(() =>
            ShowTrayBalloon(
                ClipNotifyText(title, Strings.Notify_TaskComplete, 60),
                ClipNotifyText(body, Strings.Notify_TaskUpdate, 240),
                System.Windows.Forms.ToolTipIcon.Info)));
        watcher.Revoked += reason => Dispatcher.BeginInvoke(new Action(() =>
        {
            // Keep the icon alive until the balloon has been shown; hiding it first
            // discarded the notification the user needs to see.
            StopTaskWatcher(keepTrayIcon: true);
            ShowTrayBalloon(Strings.Notify_DeviceRevokedTitle,
                string.Format(Strings.Notify_DeviceRevokedBody, reason),
                System.Windows.Forms.ToolTipIcon.Warning);
        }));
        _watcher = watcher;
        EnsureTrayIcon();
        _trayIcon!.Visible = true;
        _trayIcon.Text = Strings.Notify_TrayWatcher;
        watcher.Start(session.SessionToken);
    }

    private void StopTaskWatcher(bool keepTrayIcon = false)
    {
        _watcher?.Dispose();
        _watcher = null;
        if (!keepTrayIcon && _trayIcon is not null) _trayIcon.Visible = false;
    }

    private async Task<NativeSession> RenewForWatcherAsync(CancellationToken ct)
    {
        var current = _current
            ?? throw new InvalidOperationException(Strings.Connect_CredentialUnavailable);
        var token = current.GetDeviceToken()
            ?? throw new InvalidOperationException(Strings.Connect_CredentialUnavailable);
        var renewed = await GatewayAuth.RenewAsync(current, token, ct);
        Dispatcher.Invoke(() =>
        {
            if (_core is not null) InstallCookies(renewed);
        });
        return renewed;
    }

    /// <summary>
    /// Keep the default window inside the work area, without shrinking it on a
    /// display that has room.
    /// </summary>
    /// <remarks>
    /// The declared size is a comfortable default on a large desktop. It is only
    /// reduced when the screen genuinely cannot hold it, because a window wider
    /// than the display clipped the right-hand rail and the card actions.
    /// </remarks>
    private void FitToScreen()
    {
        var area = SystemParameters.WorkArea;
        if (area.Width <= 0 || area.Height <= 0) return;
        var availableWidth = area.Width - 32;
        var availableHeight = area.Height - 32;
        // Only clamp when the screen is smaller than the default; never grow past it.
        if (availableWidth < Width) Width = Math.Max(MinWidth, availableWidth);
        if (availableHeight < Height) Height = Math.Max(MinHeight, availableHeight);
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
    }

    /// <summary>Point the window, taskbar, tray and the icon preview at the selected artwork.</summary>
    /// <remarks>
    /// The preview shows the artwork only: the icon names ("默认（眨眼指手机）" and friends)
    /// described the same picture twice and were removed on request. The preview is the
    /// same <c>BrandMark</c> image the device page uses, so one assignment keeps both in
    /// step when the choice changes in the settings page.
    /// </remarks>
    private void ApplyAppIcon()
    {
        var image = AppIcons.LoadImage(_appIcon);
        if (image is not null)
        {
            Icon = image;
            BrandMark.Source = image;
        }
        if (_trayIcon is not null)
        {
            var previous = _trayIconHandle;
            _trayIconHandle = AppIcons.LoadTrayIcon(_appIcon) ?? System.Drawing.SystemIcons.Application;
            _trayIcon.Icon = _trayIconHandle;
            // The NotifyIcon copies the handle, so the old one can go.
            if (!ReferenceEquals(previous, _trayIconHandle)) previous?.Dispose();
        }
        VersionText.Text = $"DSH Mobile Windows {CurrentVersion}";
    }

    /// <summary>Cycle to the next pose; the choice is stored beside the device list.</summary>
    private void CycleIcon_Click(object sender, RoutedEventArgs e)
    {
        var index = AppIcons.All.ToList().FindIndex(choice => choice.Id == _appIcon.Id);
        _appIcon = AppIcons.All[(index + 1) % AppIcons.All.Count];
        ApplyAppIcon();
        // One writer for settings.json: writing a second, narrower document here used
        // to erase the theme, start behaviour and notification choice.
        _settings.Icon = _appIcon.Id;
        _settings.Save(DataRoot);
        Log("app icon: " + _appIcon.Id);
    }

    private void EnsureTrayIcon()
    {
        if (_trayIcon is not null) return;
        _trayIconHandle = AppIcons.LoadTrayIcon(_appIcon) ?? System.Drawing.SystemIcons.Application;
        _trayIcon = new System.Windows.Forms.NotifyIcon
        {
            Icon = _trayIconHandle,
            Text = "DeepSeek Harness",
            Visible = false,
        };
        _trayIcon.BalloonTipClicked += (_, _) => Dispatcher.BeginInvoke(new Action(() =>
        {
            if (_current is not null) ShowBrowserPage(_current);
            // A balloon click usually arrives while the window is minimised, so
            // activating alone would leave it behind the taskbar.
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            Show();
            Activate();
            Topmost = true;
            Topmost = false;
        }));
    }

    private void ShowTrayBalloon(string title, string body, System.Windows.Forms.ToolTipIcon icon)
    {
        if (_trayIcon is null) return;
        _trayIcon.BalloonTipTitle = title;
        _trayIcon.BalloonTipText = body;
        _trayIcon.BalloonTipIcon = icon;
        _trayIcon.ShowBalloonTip(15000);
    }

    private static string ClipNotifyText(string? value, string fallback, int maxRunes)
    {
        var text = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        var clipped = string.Concat(text.EnumerateRunes().Take(maxRunes));
        return clipped.Length < text.Length ? clipped + "…" : clipped;
    }

    private void Log(string message)
    {
        // ClientLog rotates at 2 MB and keeps one previous file, so a long-running
        // install cannot fill the portable folder with an unbounded log.
        lock (_logLock) { ClientLog.Write(LogPath, message); }
    }
}
