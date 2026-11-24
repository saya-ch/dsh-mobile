using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Microsoft.Win32;

namespace DshMobile.Win;

public partial class App : Application
{
    /// <summary>
    /// MASTER.md: short state transitions only, and respect reduced motion.
    /// ClientAreaAnimation maps to Windows' "animate controls and elements
    /// inside windows" accessibility setting.
    /// </summary>
    internal static bool MotionEnabled { get; private set; } = true;

    /// <summary>Where the crash dialog tells the user to look.</summary>
    private static string LogPath => CrashGuard.DefaultLogPath(AppContext.BaseDirectory);

    protected override void OnStartup(StartupEventArgs e)
    {
        // Installed before any window exists: an exception during startup would
        // otherwise terminate the process with no message at all.
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnAppDomainUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
        base.OnStartup(e);
        MotionEnabled = SystemParameters.ClientAreaAnimation;
        // The stored preference wins over the Windows setting; "system" defers to it.
        var preference = ReadThemePreference();
        if (!UsesLightTheme(preference)) ApplyDarkPalette();
        else ApplyLightPalette();
    }

    /// <summary>
    /// UI-thread exceptions: report and keep running. A window that throws while
    /// handling a click used to close the whole client.
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        e.Handled = true;
        CrashGuard.Report(e.Exception, LogPath, ShowCrashDialog);
    }

    /// <summary>
    /// Non-UI-thread exceptions. The CLR terminates the process after this event, so
    /// the dialog is shown while the UI thread is still alive and the log is written
    /// first: the user's next launch can point at the same file.
    /// </summary>
    private void OnAppDomainUnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        var error = e.ExceptionObject as Exception
            ?? new InvalidOperationException("unknown unhandled error: " + e.ExceptionObject);
        CrashGuard.Report(error, LogPath, ShowCrashDialog);
    }

    /// <summary>Background task faults that nobody awaited are logged, not escalated.</summary>
    private static void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        try { ClientLog.Write(LogPath, "unobserved task exception: " + e.Exception); }
        catch { /* best effort */ }
        e.SetObserved();
    }

    private void ShowCrashDialog(string message)
    {
        var owner = Windows.Count > 0 ? Windows[0] : null;
        if (owner is not null && owner.IsLoaded)
        {
            MessageBox.Show(owner, message, CrashGuard.Title,
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        MessageBox.Show(message, CrashGuard.Title, MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    /// <summary>
    /// Read the theme preference the settings page stores.
    /// </summary>
    /// <remarks>
    /// The file is read directly rather than through MainWindow so the palette is
    /// correct before the first window paints. A missing or unreadable file means
    /// "system", which is also the default the settings page writes.
    /// </remarks>
    private static string ReadThemePreference()
    {
        try
        {
            var path = System.IO.Path.Combine(AppContext.BaseDirectory, "data", "settings.json");
            if (!System.IO.File.Exists(path)) return "system";
            using var stream = System.IO.File.OpenRead(path);
            using var document = System.Text.Json.JsonDocument.Parse(stream);
            return document.RootElement.TryGetProperty("Theme", out var theme)
                && theme.ValueKind == System.Text.Json.JsonValueKind.String
                ? theme.GetString() ?? "system" : "system";
        }
        catch
        {
            return "system";
        }
    }

    /// <summary>
    /// Re-apply the palette after the user changes the preference at runtime.
    /// </summary>
    /// <remarks>
    /// Every control references its colors through DynamicResource, so replacing the
    /// brush resources repaints the whole window without rebuilding it.
    /// </remarks>
    internal void ApplyThemePreference(string preference)
    {
        if (UsesLightTheme(preference)) ApplyLightPalette();
        else ApplyDarkPalette();
        // The native caption is painted by DWM, not by our brushes, so swapping the
        // palette alone leaves a light titlebar above a dark page.
        (MainWindow as MainWindow)?.RefreshCaptionColor();
    }

    private static bool UsesLightTheme(string? preference = null)
    {
        // An explicit in-app choice is what the user sees selected, so it must win:
        // honouring the environment override first made the settings page claim
        // "dark" while the window stayed light.
        if (preference == "dark") return false;
        if (preference == "light") return true;
        // Verification override, and only when no choice was stored.
        var mode = Environment.GetEnvironmentVariable("DSH_MOBILE_THEME");
        if (mode == "dark") return false;
        if (mode == "light") return true;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is not int value || value != 0;
        }
        catch
        {
            return true;
        }
    }

    /// <summary>
    /// Replace the brushes rather than mutating them: WPF freezes Freezables
    /// declared in a ResourceDictionary. All color references are DynamicResource,
    /// so the whole UI follows the new palette.
    /// </summary>
    /// <remarks>
    /// The dark set is calibrated for the desktop shell rather than copied from the
    /// phone resources: the page canvas sits below the card surface, the rail sits
    /// below the canvas, and each step is a visible but quiet change. The phone's
    /// #1E293B card over #0F172A read as one flat blue at 1600px, and its #475569
    /// border was brighter than the surface it framed.
    /// </remarks>
    private void ApplyDarkPalette()
    {
        (string Key, Color Color)[] dark =
        [
            ("AppBackgroundBrush",   Color.FromRgb(0x0A, 0x10, 0x1E)),
            ("CardBrush",            Color.FromRgb(0x15, 0x1E, 0x2E)),
            ("CardElevatedBrush",    Color.FromRgb(0x1A, 0x24, 0x36)),
            ("CardBorderBrush",      Color.FromRgb(0x33, 0x42, 0x5C)),
            ("RailBrush",            Color.FromRgb(0x08, 0x0D, 0x18)),
            ("RailBorderBrush",      Color.FromRgb(0x1B, 0x24, 0x35)),
            ("SurfaceAltBrush",      Color.FromRgb(0x10, 0x18, 0x28)),
            ("OutlineBrush",         Color.FromRgb(0x3A, 0x49, 0x64)),
            ("DividerBrush",         Color.FromRgb(0x33, 0x42, 0x5C)),
            ("PrimaryTextBrush",     Color.FromRgb(0xF2, 0xF5, 0xF9)),
            ("SecondaryTextBrush",   Color.FromRgb(0xA9, 0xB6, 0xCB)),
            ("MutedTextBrush",       Color.FromRgb(0x8A, 0x97, 0xAC)),
            ("AccentBrush",          Color.FromRgb(0x60, 0xA5, 0xFA)),
            ("AccentHoverBrush",     Color.FromRgb(0x93, 0xC5, 0xFD)),
            ("AccentPressedBrush",   Color.FromRgb(0xBF, 0xDB, 0xFE)),
            ("AccentSoftBrush",      Color.FromRgb(0x17, 0x26, 0x3F)),
            ("AccentSoftBorderBrush", Color.FromRgb(0x1F, 0x33, 0x50)),
            ("OnAccentBrush",        Color.FromRgb(0x0B, 0x12, 0x20)),
            ("HoverBrush",           Color.FromRgb(0x1B, 0x27, 0x39)),
            ("PressedBrush",         Color.FromRgb(0x22, 0x30, 0x4A)),
            ("SwitchKnobBrush",      Color.FromRgb(0xE6, 0xEC, 0xF5)),
            ("DisabledFillBrush",    Color.FromRgb(0x22, 0x30, 0x4A)),
            ("DisabledBorderBrush",  Color.FromRgb(0x4A, 0x5C, 0x7A)),
            ("DisabledTextBrush",    Color.FromRgb(0x8A, 0x97, 0xAC)),
            ("ErrorBrush",           Color.FromRgb(0xFC, 0xA5, 0xA5)),
            ("SuccessBrush",         Color.FromRgb(0x4A, 0xDE, 0x80)),
            ("WarningBrush",         Color.FromRgb(0xFB, 0xBF, 0x24)),
            ("ScrollThumbBrush",     Color.FromRgb(0x2C, 0x39, 0x50)),
            ("ScrollThumbHoverBrush", Color.FromRgb(0x41, 0x52, 0x6E)),
        ];

        foreach (var (key, color) in dark)
            Resources[key] = new SolidColorBrush(color);

        // Depth is carried by the border and the rail step in dark mode; keep the
        // shadow present but soft so it does not turn into a halo.
        Resources["CardShadow"] = new DropShadowEffect
        {
            Color = Color.FromRgb(0x00, 0x00, 0x00), BlurRadius = 22, ShadowDepth = 2,
            Direction = 270, Opacity = 0.34, RenderingBias = RenderingBias.Quality,
        };
    }

    /// <summary>Restore the light brushes declared in App.xaml.</summary>
    private void ApplyLightPalette()
    {
        (string Key, Color Color)[] light =
        [
            ("AppBackgroundBrush",   Color.FromRgb(0xF7, 0xF8, 0xFA)),
            ("CardBrush",            Color.FromRgb(0xFF, 0xFF, 0xFF)),
            ("CardElevatedBrush",    Color.FromRgb(0xFF, 0xFF, 0xFF)),
            ("CardBorderBrush",      Color.FromRgb(0xC6, 0xCC, 0xD6)),
            ("RailBrush",            Color.FromRgb(0xFD, 0xFD, 0xFF)),
            ("RailBorderBrush",      Color.FromRgb(0xE8, 0xEB, 0xF2)),
            ("SurfaceAltBrush",      Color.FromRgb(0xED, 0xF1, 0xF7)),
            ("OutlineBrush",         Color.FromRgb(0xC6, 0xCC, 0xD6)),
            ("DividerBrush",         Color.FromRgb(0xC6, 0xCC, 0xD6)),
            ("PrimaryTextBrush",     Color.FromRgb(0x11, 0x18, 0x27)),
            ("SecondaryTextBrush",   Color.FromRgb(0x66, 0x70, 0x85)),
            ("MutedTextBrush",       Color.FromRgb(0x5F, 0x6A, 0x7A)),
            ("AccentBrush",          Color.FromRgb(0x25, 0x63, 0xEB)),
            ("AccentHoverBrush",     Color.FromRgb(0x1D, 0x4E, 0xD8)),
            ("AccentPressedBrush",   Color.FromRgb(0x1E, 0x40, 0xAF)),
            ("AccentSoftBrush",      Color.FromRgb(0xE9, 0xEF, 0xFD)),
            ("AccentSoftBorderBrush", Color.FromRgb(0xD6, 0xE2, 0xFB)),
            ("OnAccentBrush",        Color.FromRgb(0xFF, 0xFF, 0xFF)),
            ("HoverBrush",           Color.FromRgb(0xF1, 0xF4, 0xF9)),
            ("PressedBrush",         Color.FromRgb(0xE6, 0xEB, 0xF2)),
            ("SwitchKnobBrush",      Color.FromRgb(0xFF, 0xFF, 0xFF)),
            ("DisabledFillBrush",    Color.FromRgb(0xE6, 0xEB, 0xF2)),
            ("DisabledBorderBrush",  Color.FromRgb(0xA7, 0xB3, 0xC4)),
            ("DisabledTextBrush",    Color.FromRgb(0x6B, 0x77, 0x89)),
            ("ErrorBrush",           Color.FromRgb(0xB9, 0x1C, 0x1C)),
            ("SuccessBrush",         Color.FromRgb(0x15, 0x80, 0x3D)),
            ("WarningBrush",         Color.FromRgb(0xB4, 0x53, 0x09)),
            ("ScrollThumbBrush",     Color.FromRgb(0xB8, 0xC2, 0xD1)),
            ("ScrollThumbHoverBrush", Color.FromRgb(0x9A, 0xA5, 0xB8)),
        ];

        foreach (var (key, color) in light)
            Resources[key] = new SolidColorBrush(color);

        Resources["CardShadow"] = new DropShadowEffect
        {
            Color = Color.FromRgb(0x0B, 0x12, 0x20), BlurRadius = 18, ShadowDepth = 2,
            Direction = 270, Opacity = 0.06, RenderingBias = RenderingBias.Quality,
        };
    }
}
