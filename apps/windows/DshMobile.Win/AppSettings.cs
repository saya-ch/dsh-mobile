using System.IO;
using System.Text.Json;

namespace DshMobile.Win;

/// <summary>
/// Desktop preferences that belong to the shell rather than to a paired device.
/// </summary>
/// <remarks>
/// The phone app keeps its preferences on a dedicated settings screen; the
/// desktop keeps the equivalents here so both products answer the same questions
/// (start behaviour, icon, theme, window chrome). Values are stored beside the
/// device list so a portable folder carries them, and every read falls back to the
/// default instead of failing when the file is missing or damaged.
/// </remarks>
internal sealed class AppSettings
{
    internal const string StartPageDevices = "devices";
    internal const string StartPageLastDevice = "last";
    /// <summary>Sentinel for "follow the Windows UI language".</summary>
    internal const string LanguageSystem = "system";

    public string Icon { get; set; } = "default";
    /// <summary>"devices" shows the list on launch; "last" reconnects the last device.</summary>
    public string StartPage { get; set; } = StartPageDevices;
    /// <summary>"system" | "light" | "dark".</summary>
    public string Theme { get; set; } = "system";
    /// <summary>
    /// Interface language as a culture name ("ja", "de", …), or "system" to follow Windows.
    /// </summary>
    /// <remarks>
    /// Changing this needs the window rebuilt: the XAML binds strings through
    /// <c>{x:Static}</c>, which resolves once when an element loads, so a live culture change
    /// does not repaint anything already on screen.
    /// </remarks>
    public string Language { get; set; } = LanguageSystem;
    public bool BackgroundNotifications { get; set; } = true;
    /// <summary>
    /// EndpointId of the computer connected last. "自动连接上次的电脑" needs to know
    /// which record that was; the device list alone is ordered by pairing time, which is
    /// a different question. Empty until the first successful connection.
    /// </summary>
    public string LastDeviceEndpointId { get; set; } = string.Empty;

    private static string PathFor(string dataRoot) => Path.Combine(dataRoot, "settings.json");

    internal static AppSettings Load(string dataRoot)
    {
        try
        {
            var path = PathFor(dataRoot);
            if (!File.Exists(path)) return new AppSettings();
            using var stream = File.OpenRead(path);
            return JsonSerializer.Deserialize<AppSettings>(stream) ?? new AppSettings();
        }
        catch
        {
            return new AppSettings();
        }
    }

    internal void Save(string dataRoot)
    {
        try
        {
            var path = PathFor(dataRoot);
            var temporary = path + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, path, overwrite: true);
        }
        catch
        {
            // A read-only portable folder keeps the in-memory values for this run.
        }
    }
}
