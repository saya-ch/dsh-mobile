using System.Windows;
using System.Windows.Media;
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

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        MotionEnabled = SystemParameters.ClientAreaAnimation;
        if (!UsesLightTheme()) ApplyDarkPalette();
    }

    private static bool UsesLightTheme()
    {
        // Portable override for verification / user preference; no registry writes.
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
    private void ApplyDarkPalette()
    {
        (string Key, Color Color)[] dark =
        [
            ("AppBackgroundBrush", Color.FromRgb(0x0F, 0x17, 0x2A)),
            ("CardBrush",          Color.FromRgb(0x1E, 0x29, 0x3B)),
            ("PrimaryTextBrush",   Color.FromRgb(0xF8, 0xFA, 0xFC)),
            ("SecondaryTextBrush", Color.FromRgb(0xCB, 0xD5, 0xE1)),
            ("AccentBrush",        Color.FromRgb(0x60, 0xA5, 0xFA)),
            ("AccentHoverBrush",   Color.FromRgb(0x93, 0xC5, 0xFD)),
            ("AccentPressedBrush", Color.FromRgb(0xBF, 0xDB, 0xFE)),
            ("OnAccentBrush",      Color.FromRgb(0x0F, 0x17, 0x2A)),
            ("OutlineBrush",       Color.FromRgb(0x47, 0x55, 0x69)),
            ("ErrorBrush",         Color.FromRgb(0xFC, 0xA5, 0xA5)),
            ("SurfaceAltBrush",    Color.FromRgb(0x17, 0x24, 0x3A)),
            ("HoverBrush",         Color.FromRgb(0x2A, 0x3A, 0x50)),
            ("PressedBrush",       Color.FromRgb(0x33, 0x45, 0x5E)),
        ];

        foreach (var (key, color) in dark)
            Resources[key] = new SolidColorBrush(color);
    }
}
