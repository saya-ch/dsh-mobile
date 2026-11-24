using Xunit;

namespace DshMobile.Win.Tests;

public class RelativeTimeTests
{
    private static readonly DateTimeOffset Now =
        DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000L);

    private static long Ago(TimeSpan elapsed) => Now.ToUnixTimeMilliseconds() - (long)elapsed.TotalMilliseconds;

    [Fact]
    public void AbsentTimestampIsNeverConnected() =>
        Assert.Equal(RelativeTime.Never, RelativeTime.Format(0, Now));

    [Fact]
    public void NegativeTimestampIsAlsoTreatedAsAbsent() =>
        // An unset long reads 0; a corrupt record must not render a 1969 date.
        Assert.Equal(RelativeTime.Never, RelativeTime.Format(-1, Now));

    [Theory]
    [InlineData(0)]
    [InlineData(1_000)]
    [InlineData(59_999)]
    public void UnderAMinuteIsJustNow(int elapsedMs) =>
        Assert.Equal(RelativeTime.JustNow, RelativeTime.Format(Ago(TimeSpan.FromMilliseconds(elapsedMs)), Now));

    [Theory]
    [InlineData(60_000, "1 分钟前")]
    [InlineData(90_000, "1 分钟前")]      // truncates, does not round up
    [InlineData(119_999, "1 分钟前")]
    [InlineData(120_000, "2 分钟前")]
    [InlineData(3_599_999, "59 分钟前")]
    public void MinutesBoundary(int elapsedMs, string expected) =>
        Assert.Equal(expected, RelativeTime.Format(Ago(TimeSpan.FromMilliseconds(elapsedMs)), Now));

    [Theory]
    [InlineData(3_600_000, "1 小时前")]
    [InlineData(5_400_000, "1 小时前")]
    [InlineData(7_200_000, "2 小时前")]
    [InlineData(86_399_999, "23 小时前")]
    public void HoursBoundary(int elapsedMs, string expected) =>
        Assert.Equal(expected, RelativeTime.Format(Ago(TimeSpan.FromMilliseconds(elapsedMs)), Now));

    [Theory]
    [InlineData(86_400_000, "1 天前")]
    [InlineData(172_800_000, "2 天前")]
    [InlineData(604_799_999, "6 天前")]   // just under a week still counts in days
    public void DaysBoundary(int elapsedMs, string expected) =>
        Assert.Equal(expected, RelativeTime.Format(Ago(TimeSpan.FromMilliseconds(elapsedMs)), Now));

    [Fact]
    public void AWeekOrOlderFallsBackToAnAbsoluteDate()
    {
        // Mirrors Android formatLastConnected: beyond 7 days it prints a date instead.
        var timestamp = Ago(TimeSpan.FromDays(7));
        var expected = DateTimeOffset.FromUnixTimeMilliseconds(timestamp).ToLocalTime()
            .ToString("yyyy-MM-dd");
        Assert.Equal(expected, RelativeTime.Format(timestamp, Now));
    }

    [Fact]
    public void FutureTimestampClampsToJustNow()
    {
        // Clock skew, or a record written by a computer whose clock ran ahead: a
        // negative elapsed must not print "-3 分钟前".
        var future = Now.ToUnixTimeMilliseconds() + 600_000L;
        Assert.Equal(RelativeTime.JustNow, RelativeTime.Format(future, Now));
    }

    [Fact]
    public void AbsoluteDateIsEmptyForAnAbsentTimestamp() =>
        Assert.Equal(string.Empty, RelativeTime.AbsoluteDate(0));

    [Fact]
    public void AbsoluteDateUsesTheLocalCalendarDay()
    {
        var timestamp = Now.ToUnixTimeMilliseconds();
        Assert.Equal(
            DateTimeOffset.FromUnixTimeMilliseconds(timestamp).ToLocalTime().ToString("yyyy-MM-dd"),
            RelativeTime.AbsoluteDate(timestamp));
    }
}
