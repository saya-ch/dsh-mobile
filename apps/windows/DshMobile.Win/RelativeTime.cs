using System.Globalization;

namespace DshMobile.Win;

/// <summary>
/// The "last connected" wording on a device card, mirroring the Android client
/// (MainActivity.formatLastConnected): just now, N minutes, N hours, N days, and an
/// absolute date once the row is a week old.
/// </summary>
/// <remarks>
/// Pure, with the clock injected, so every threshold is unit-testable without freezing
/// the machine clock. A timestamp in the future (clock skew, or a record written by a
/// computer whose clock ran ahead) clamps to "just now" instead of showing a negative
/// count; a missing timestamp is "never connected" rather than a 1970 date.
/// </remarks>
internal static class RelativeTime
{
    /// <summary>Shown when the record has no connection timestamp at all.</summary>
    internal const string Never = "从未连接";

    /// <summary>Shown for anything under a minute old, including clock skew.</summary>
    internal const string JustNow = "刚刚";

    private const long MinuteMs = 60_000L;
    private const long HourMs = 60 * MinuteMs;
    private const long DayMs = 24 * HourMs;
    private const long WeekMs = 7 * DayMs;

    /// <summary>
    /// Relative wording for a Unix-millisecond timestamp; <see cref="Never"/> when the
    /// timestamp is absent (0 or negative, which is also how an unset long reads).
    /// </summary>
    internal static string Format(long unixMilliseconds, DateTimeOffset now)
    {
        if (unixMilliseconds <= 0) return Never;
        var elapsed = now.ToUnixTimeMilliseconds() - unixMilliseconds;
        if (elapsed < 0) elapsed = 0;
        if (elapsed < MinuteMs) return JustNow;
        if (elapsed < HourMs) return Math.Max(1L, elapsed / MinuteMs).ToString(CultureInfo.InvariantCulture) + " 分钟前";
        if (elapsed < DayMs) return Math.Max(1L, elapsed / HourMs).ToString(CultureInfo.InvariantCulture) + " 小时前";
        if (elapsed < WeekMs) return Math.Max(1L, elapsed / DayMs).ToString(CultureInfo.InvariantCulture) + " 天前";
        return DateTimeOffset.FromUnixTimeMilliseconds(unixMilliseconds).ToLocalTime()
            .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }

    /// <summary>Absolute local date for the same timestamp, or an empty string when absent.</summary>
    internal static string AbsoluteDate(long unixMilliseconds)
    {
        if (unixMilliseconds <= 0) return string.Empty;
        return DateTimeOffset.FromUnixTimeMilliseconds(unixMilliseconds).ToLocalTime()
            .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }
}
