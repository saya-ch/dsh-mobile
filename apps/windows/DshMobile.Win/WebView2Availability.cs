using DshMobile.Win.Resources;

namespace DshMobile.Win;

/// <summary>
/// Detects whether the WebView2 Evergreen Runtime is installed and explains how to
/// install it.
/// </summary>
/// <remarks>
/// The client cannot render the DSH page without the runtime. Previously a missing
/// runtime surfaced only as "WebView2 init timed out" after a 25 second wait, which
/// reads like a network problem. The runtime reports its version synchronously, so the
/// check happens before any environment is created and the user gets one instruction
/// instead of a timeout. The version probe itself is injected, keeping this class free
/// of WebView2 types so it stays unit-testable.
/// </remarks>
internal static class WebView2Availability
{
    internal const string DownloadUrl = "https://developer.microsoft.com/microsoft-edge/webview2";

    internal static string MissingTitle => Strings.WebView_RuntimeMissingTitle;

    internal static string MissingMessage =>
        string.Format(Strings.WebView_RuntimeMissingMessage, DownloadUrl);

    /// <summary>
    /// True when the probe returns a parseable runtime version.
    /// </summary>
    internal static bool IsAvailable(string? reportedVersion) =>
        !string.IsNullOrWhiteSpace(reportedVersion) && Version.TryParse(reportedVersion, out _);

    /// <summary>
    /// Run the version probe, treating "no runtime installed" and any thrown error as
    /// unavailable. Returns the reported version, or null when the runtime is missing.
    /// </summary>
    internal static string? Detect(Func<string?> probe)
    {
        try
        {
            var version = probe();
            return IsAvailable(version) ? version : null;
        }
        catch
        {
            // WebView2Loader.dll missing / unsupported platform: same user-facing outcome.
            return null;
        }
    }
}
