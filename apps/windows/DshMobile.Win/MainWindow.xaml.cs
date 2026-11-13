using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Interop;
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
    private static readonly string DataRoot = Path.Combine(Root, "data");
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
    private CoreWebView2? _core;
    private bool _certificateHandlerAttached;
    private CancellationTokenSource? _connectCts;
    private string _irohDiagnostics = string.Empty;
    private bool _busy;
    private bool _userCancelled;

    public MainWindow()
    {
        InitializeComponent();
        Directory.CreateDirectory(DataRoot);
        _store = new DeviceStore(DevicesPath, Log);
        Log($"portable root: {Root}");
        Log($"iroh identity: {IdentityDir}");
        RefreshDeviceList();
        Loaded += async (_, _) =>
        {
            ApplyCaptionColor();
            await InitializeWebViewAsync();
        };
        Closed += (_, _) => DisconnectCore();
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>
    /// Paint the DWM caption with the same token as the embedded bar, so the native
    /// titlebar and the in-app bar read as one continuous surface (Win11+; on older
    /// systems the system caption color is kept).
    /// </summary>
    private void ApplyCaptionColor()
    {
        try
        {
            if (FindResource("AppBackgroundBrush") is not SolidColorBrush brush) return;
            var c = brush.Color;
            int colorref = c.R | (c.G << 8) | (c.B << 16); // COLORREF is 0x00BBGGRR
            var hwnd = new WindowInteropHelper(this).Handle;
            DwmSetWindowAttribute(hwnd, 35 /* DWMWA_CAPTION_COLOR */, ref colorref, sizeof(int));
        }
        catch
        {
            // DWMWA_CAPTION_COLOR needs Windows 11; silently keep the default.
        }
    }

    private void RefreshDeviceList()
    {
        DeviceList.Children.Clear();
        _connectButtons.Clear();
        var devices = _store.All;
        var hasDevices = devices.Count > 0;
        NoDevicesText.Visibility = hasDevices ? Visibility.Collapsed : Visibility.Visible;
        // With no saved device the pairing input is the only action, so hide the
        // toggle instead of showing a confusing "collapse" button.
        AddToggleButton.Visibility = hasDevices ? Visibility.Visible : Visibility.Collapsed;
        if (!hasDevices) ShowAddPanel(true);
        foreach (var device in devices)
        {
            // Semantic token resources (design-system/MASTER.md). DynamicResource
            // references follow the light/dark palette applied at startup.
            var info = new StackPanel();
            var name = new TextBlock
            {
                Text = device.Name, FontSize = 14, FontWeight = FontWeights.SemiBold,
            };
            name.SetResourceReference(TextBlock.ForegroundProperty, "PrimaryTextBrush");
            info.Children.Add(name);

            var paired = DateTimeOffset.FromUnixTimeMilliseconds(device.PairedAt).LocalDateTime;
            var expiry = device.DeviceExpiresAt > 0
                ? " · 凭据至 " + DateTimeOffset.FromUnixTimeMilliseconds(device.DeviceExpiresAt).LocalDateTime.ToString("yyyy-MM-dd")
                : string.Empty;
            var channelLabel = device.Channel switch
            {
                "lan" => "局域网",
                "remote" => "远程",
                _ => "iroh",
            };
            var detail = new TextBlock
            {
                Text = $"{channelLabel} · {device.ShortId}… · 配对 {paired:yyyy-MM-dd}{expiry}",
                FontSize = 12,
                Margin = new Thickness(0, 4, 0, 0),
            };
            detail.SetResourceReference(TextBlock.ForegroundProperty, "SecondaryTextBrush");
            info.Children.Add(detail);

            if (!device.CanReconnect)
            {
                var warning = new TextBlock
                {
                    Text = "凭据已过期或不可读，需要重新扫码配对",
                    FontSize = 12,
                    Margin = new Thickness(0, 4, 0, 0),
                };
                warning.SetResourceReference(TextBlock.ForegroundProperty, "ErrorBrush");
                info.Children.Add(warning);
            }

            var rename = new Button
            {
                Content = "重命名", Width = 80,
                Margin = new Thickness(12, 0, 0, 0), Tag = device,
                ToolTip = "仅修改本机显示名称",
            };
            rename.Click += RenameDevice_Click;
            var connect = new Button
            {
                Content = "连接", Width = 96,
                Margin = new Thickness(8, 0, 0, 0), Tag = device,
                Style = (Style)FindResource("PrimaryButton"),
            };
            connect.Click += ConnectSaved_Click;
            var remove = new Button
            {
                Content = "删除", Width = 72,
                Margin = new Thickness(8, 0, 0, 0), Tag = device,
            };
            remove.Click += RemoveDevice_Click;
            _connectButtons.Add(rename);
            _connectButtons.Add(connect);
            _connectButtons.Add(remove);

            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.Children.Add(info);
            grid.Children.Add(rename);
            grid.Children.Add(connect);
            grid.Children.Add(remove);
            Grid.SetColumn(rename, 1);
            Grid.SetColumn(connect, 2);
            Grid.SetColumn(remove, 3);

            var card = new Border
            {
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10), // desktop-scale radius per user preference
                Padding = new Thickness(16),
                Margin = new Thickness(0, 0, 0, 10),
                Child = grid,
            };
            card.SetResourceReference(Border.BackgroundProperty, "CardBrush");
            card.SetResourceReference(Border.BorderBrushProperty, "OutlineBrush");
            DeviceList.Children.Add(card);
        }
    }

    private void ShowAddPanel(bool show)
    {
        AddPanel.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        AddToggleButton.Content = show ? "收起" : "添加新电脑";
    }

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
                device = SavedDevice.FromUrlPairing(link);
                gatewayToken = link.Token;
                Log($"url pairing link: channel={link.Mode} requiresCa={link.RequiresCa}");
            }
            catch (Exception urlError)
            {
                Log($"descriptor rejected: iroh={irohError.Message} url={urlError.Message}");
                MessageBox.Show(this,
                    "配对内容无效。\n\niroh 描述符错误：" + irohError.Message +
                    "\n配对链接错误：" + urlError.Message,
                    "配对内容无效", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
        }
        DescriptorBox.Text = string.Empty; // one-time secrets never stay in the UI
        await ConnectToAsync(device, irohCode, gatewayToken);
    }

    private async void ConnectSaved_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var device = (SavedDevice)((Button)sender).Tag;
        if (!device.CanReconnect || device.GetDeviceToken() is null)
        {
            ShowAddPanel(true);
            DescriptorBox.Focus();
            MessageBox.Show(this, "这台电脑的设备凭据已过期或无法读取，请重新扫码配对。",
                "需要重新配对", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        await ConnectToAsync(device, null, null);
    }

    private void RemoveDevice_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var device = (SavedDevice)((Button)sender).Tag;
        if (MessageBox.Show(this, $"删除已配对电脑「{device.Name}」？下次连接需要重新扫码。",
                "删除设备", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        _store.Remove(device.EndpointId, Log);
        RefreshDeviceList();
        Log("removed saved device: " + device.EndpointId);
    }

    private void RenameDevice_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var device = (SavedDevice)((Button)sender).Tag;
        var dialog = new RenameDialog(device.Name) { Owner = this };
        if (dialog.ShowDialog() != true) return;
        _store.Rename(device.EndpointId, dialog.DeviceName, Log);
        RefreshDeviceList();
        if (_current?.EndpointId == device.EndpointId)
        {
            _current.Name = dialog.DeviceName;
            BrowserTitle.Text = "已连接 · " + dialog.DeviceName;
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
                SetProgress("正在连接 iroh");
                var carrier = await StartCarrierWithRetryAsync(device, pairingCode, _connectCts.Token);
                _carrier = carrier;
                carrier.Failed += reason =>
                {
                    Log(reason);
                    try { Dispatcher.BeginInvoke(new Action(() => { if (_carrier is not null) SetProgress("连接已中断"); })); }
                    catch { /* window closed */ }
                };
                Log("iroh transport ready: " + carrier.ProxyOrigin);
                session = await AuthorizeAsync(device, pairingCode, gatewayToken);
            }
            else
            {
                SetProgress("正在验证电脑");
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

            SetProgress("正在加载页面");
            var webViewTask = EnsureWebViewAsync();
            var webViewTimeout = Task.Delay(TimeSpan.FromSeconds(25), _connectCts.Token);
            if (await Task.WhenAny(webViewTask, webViewTimeout) != webViewTask)
                throw new TimeoutException("WebView2 init timed out");
            await webViewTask;

            _current = device;
            InstallCookies(session);
            await ClearCachedCertificateDecisionsAsync();
            ShowBrowserPage(device);
            _core!.Navigate(device.Origin);
            Log("connected: " + device.Origin);
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
            MessageBox.Show(this, hint, "连接失败", MessageBoxButton.OK, MessageBoxImage.Warning);
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
        SetProgress("正在授权");
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
            ?? throw new InvalidOperationException("设备凭据不可用，请重新扫码配对");
        var renewed = await GatewayAuth.RenewAsync(device, token, _connectCts!.Token);
        Log("session renewed without a QR code");
        return renewed;
    }

    private (string Hint, bool Repair) BuildHint(Exception error, string diagnostics, SavedDevice device)
    {
        var prefix = device.ShortId;
        var message = error.Message;
        bool credential = message.Contains("设备凭据", StringComparison.Ordinal) ||
                          message.Contains("device_expired", StringComparison.Ordinal) ||
                          message.Contains("device credential", StringComparison.OrdinalIgnoreCase) ||
                          message.Contains("401", StringComparison.Ordinal) ||
                          diagnostics.Contains("did not acknowledge", StringComparison.OrdinalIgnoreCase) ||
                          diagnostics.Contains("pairing rejected", StringComparison.OrdinalIgnoreCase);
        if (credential)
            return ($"这台电脑的设备凭据已失效，或电脑端已撤销此设备。\n\n" +
                    $"实例：{prefix}…\n请重新生成二维码并完成一次配对。", true);
        if (device.Channel != "iroh")
        {
            if (message.Contains("配对 CA 与二维码指纹不匹配", StringComparison.Ordinal))
                return ("连接到的电脑与二维码指向的不是同一台（CA 指纹不匹配）。\n" +
                        "请确认二维码来自这台电脑，且中间没有地址劫持。", false);
            if (message.Contains("无法解析主机", StringComparison.Ordinal))
                return ($"无法解析电脑地址 {device.Hostname}。\n\n" +
                        (device.Channel == "lan"
                            ? "局域网连接：请确认本机与电脑在同一网络，电脑端网关正在运行。"
                            : "远程连接：请确认远程通道（Tailscale/cpolar/cloudflared 等）正在运行，且域名可访问。"), false);
            if (error is SocketException || message.Contains("refused", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("timed out", StringComparison.OrdinalIgnoreCase) ||
                message.Contains("无法连接", StringComparison.Ordinal))
                return ("无法建立到电脑端网关的 HTTPS 连接。\n\n" +
                        (device.Channel == "lan"
                            ? "局域网连接：请确认本机与电脑在同一网络，防火墙放行了网关端口，且通道处于就绪状态。"
                            : "远程连接：请确认远程通道正在运行，公网可访问该地址。"), false);
        }
        if (error is OperationCanceledException || error is TimeoutException)
            return ("连接超时。请确认电脑端 iroh 通道处于就绪状态、两端网络可达，然后重试。", false);
        if (diagnostics.Contains("No addressing information", StringComparison.OrdinalIgnoreCase))
            return ("iroh 找不到该电脑端的地址（已自动重试 2 次）。\n\n" +
                    $"EndpointId：{prefix}…\n" +
                    "请在代理/VPN 中放行 dns.iroh.link、iroh.link、relay.iroh.network 的 DNS 与 UDP。", false);
        if (diagnostics.Contains("host connection timed out", StringComparison.OrdinalIgnoreCase))
            return ("iroh 在 15 秒内没能连上二维码指向的电脑端（已自动重试 2 次）。\n\n" +
                    $"EndpointId：{prefix}…\n" +
                    "常见原因：电脑端通道刚重启、发现记录尚未传播，或代理/VPN 拦了 UDP。\n" +
                    "请确认通道就绪后重试；详细诊断见 data\\client.log。", false);
        return (message, false);
    }

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
        SetProgress("正在准备 iroh 组件");
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
                SetProgress($"正在重试连接 ({attempt + 1}/{MaxConnectAttempts})");
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

    private void ShowBrowserPage(SavedDevice device)
    {
        WebView.Visibility = Visibility.Visible;
        ConnectPage.Visibility = Visibility.Collapsed;
        Title = "DeepSeek Harness — " + device.Name;
        BrowserTitle.Text = "已连接 · " + device.Name;
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
    /// navigate, pop-ups/downloads/permissions are denied, and a renderer crash is
    /// reported and recovered with a reload.
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
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        if (_current is null || !Uri.TryCreate(_current.Origin, UriKind.Absolute, out var expected)) return false;
        return string.Equals(uri.GetLeftPart(UriPartial.Authority),
            expected.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsExternalHttps(string raw) =>
        Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps;

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
        else NotifyPolicyOnce("navigation", "已阻止非网关地址的导航。");
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        Log("blocked new window: " + e.Uri);
        if (IsExternalHttps(e.Uri)) OpenInSystemBrowser(e.Uri);
        else NotifyPolicyOnce("popup", "已阻止弹出窗口。");
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        e.Cancel = true;
        e.Handled = true;
        Log("blocked download: " + e.DownloadOperation.Uri);
        NotifyPolicyOnce("download", "Windows 客户端暂不支持下载，已阻止该请求。");
    }

    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        e.State = CoreWebView2PermissionState.Deny;
        Log("denied permission: " + e.PermissionKind);
        if (e.PermissionKind == CoreWebView2PermissionKind.Microphone)
            NotifyPolicyOnce("microphone", "Windows 客户端暂不支持语音输入（麦克风权限已拒绝）。");
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log($"WebView2 process failed: {e.ProcessFailedKind} (exit {e.ExitCode})");
        // A renderer/frame crash can be reloaded; a browser process exit cannot.
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            NotifyPolicyOnce("browser-exit", "浏览器进程已退出，请断开后重新连接。");
            return;
        }
        try
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                if (_core is null || _current is null) return;
                NotifyPolicyOnce("renderer-reload", "页面进程异常，正在重新加载。");
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
                MessageBox.Show(this, message, "Windows 客户端", MessageBoxButton.OK, MessageBoxImage.Information)));
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
        _carrier?.Dispose();
        _carrier = null;
        _current = null;
    }

    private void Log(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {message}";
        try { lock (_logLock) { File.AppendAllText(LogPath, line + Environment.NewLine); } }
        catch { /* disk full */ }
    }
}
