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

    internal const string MissingTitle = "缺少 WebView2 运行时";

    internal const string MissingMessage =
        "这台电脑没有安装 Microsoft Edge WebView2 运行时，客户端无法显示 DSH 页面。\n\n" +
        "请安装后重新打开客户端：\n" +
        DownloadUrl + "\n\n" +
        "Windows 11 通常已自带；Windows 10 需要安装一次 Evergreen Runtime。\n" +
        "如果已安装仍提示缺失，请确认安装的是 x64 版本。";

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
