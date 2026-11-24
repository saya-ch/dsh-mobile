using System.IO;
using System.Text.Json;
using System.Windows.Media.Imaging;
using Drawing = System.Drawing;

namespace DshMobile.Win;

/// <summary>
/// The launcher artwork shared with the Android app, selectable by the user.
/// </summary>
/// <remarks>
/// The Windows client used to draw a generic system icon in the tray and the
/// titlebar. Both now use the same icon the phone app ships, and the three mascot
/// poses the app already offers are selectable here too, so one product reads as
/// one product on both platforms. The choice is stored beside the other runtime
/// state so it survives restarts and travels with the portable folder.
/// </remarks>
internal static class AppIcons
{
    internal sealed record Choice(string Id, string File, string Label);

    /// <summary>
    /// Every launcher artwork the Android app ships: the four mascot poses that are
    /// its default launcher set, then the six whale skins it also offers. Default
    /// first, so a user who never opens the setting keeps the phone's own icon.
    /// </summary>
    /// <remarks>
    /// "default" is the phone's actual launcher icon — the winking mascot holding a
    /// phone that shows the whale logo — not the brand master. The two drawings are
    /// different poses, and only the winking one launches the Android app. "classic"
    /// is the open-eyed pose, rendered from the 1201px brand master, which is the same
    /// drawing as the 192px Android `ic_launcher_mascot_classic` at full resolution.
    /// </remarks>
    internal static readonly IReadOnlyList<Choice> All = new[]
    {
        new Choice("default", "app.ico", "默认（眨眼指手机）"),
        new Choice("classic", "app-mascot-classic.ico", "经典（睁眼指手机）"),
        new Choice("cheer", "app-mascot-cheer.ico", "欢呼（闭眼）"),
        new Choice("quiet", "app-mascot-quiet.ico", "安静（手指抵唇）"),
        new Choice("whale", "app-whale.ico", "鲸鱼"),
        new Choice("whale-black", "app-whale-black.ico", "鲸鱼 · 黑"),
        new Choice("whale-dark", "app-whale-dark.ico", "鲸鱼 · 深色"),
        new Choice("whale-mono", "app-whale-mono.ico", "鲸鱼 · 单色"),
        new Choice("whale-teal", "app-whale-teal.ico", "鲸鱼 · 青"),
        new Choice("whale-white", "app-whale-white.ico", "鲸鱼 · 白"),
    };

    private const string SettingsFileName = "settings.json";

    internal static Choice Resolve(string? id) =>
        All.FirstOrDefault(choice => choice.Id == id) ?? All[0];

    private static string IconsRoot => Path.Combine(AppContext.BaseDirectory, "icons");

    internal static string PathFor(Choice choice) => Path.Combine(IconsRoot, choice.File);

    /// <summary>Preview bitmap at the largest frame the file carries.</summary>
    /// <remarks>
    /// A plain <see cref="BitmapImage"/> over an ICO decodes its smallest frame, so a
    /// 32px preview showed the 16px artwork upscaled — a blue smudge. The frames the
    /// icons ship with differ by size on purpose (a simplified mark below 32px, the
    /// character above it), so the preview asks for the biggest one explicitly.
    /// </remarks>
    internal static BitmapImage? LoadImage(Choice choice)
    {
        var path = PathFor(choice);
        if (!File.Exists(path)) return null;
        try
        {
            var decoder = BitmapDecoder.Create(
                new Uri(path, UriKind.Absolute),
                BitmapCreateOptions.None,
                BitmapCacheOption.OnLoad);
            var frame = decoder.Frames.OrderByDescending(f => f.PixelWidth).First();
            var stream = new MemoryStream();
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(frame));
            encoder.Save(stream);
            stream.Position = 0;
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = stream;
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Tray icon handle; the caller owns the returned icon.</summary>
    internal static Drawing.Icon? LoadTrayIcon(Choice choice)
    {
        var path = PathFor(choice);
        if (!File.Exists(path)) return null;
        try
        {
            // Copy through a stream: Icon holds the file handle otherwise, which
            // blocks replacing the artwork while the app is running.
            using var stream = File.OpenRead(path);
            return new Drawing.Icon(stream);
        }
        catch
        {
            return null;
        }
    }
}
