using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>Unhandled-exception reporting: readable text, a log path, and no recursion.</summary>
public class CrashGuardTests
{
    [Fact]
    public void LogPathSitsBesideTheExecutable()
    {
        var path = CrashGuard.DefaultLogPath(@"C:\app");
        Assert.Equal(Path.Combine(@"C:\app", "data", "client.log"), path);
    }

    [Fact]
    public void DescribeNamesTheExceptionTypeAndTheLogPath()
    {
        var log = @"C:\app\data\client.log";
        var text = CrashGuard.Describe(new InvalidOperationException("something broke"), log);
        Assert.Contains("InvalidOperationException", text);
        Assert.Contains("something broke", text);
        Assert.Contains(log, text);
        Assert.Contains("未预期", text);
    }

    [Fact]
    public void DescribeUnwrapsAnAggregateException()
    {
        var error = new AggregateException(
            new IOException("inner detail"));
        var text = CrashGuard.Describe(error, "log");
        Assert.Contains("IOException", text);
        Assert.Contains("inner detail", text);
        Assert.DoesNotContain("AggregateException", text);
    }

    [Fact]
    public void DescribeClipsAVeryLongMessage()
    {
        var text = CrashGuard.Describe(new InvalidOperationException(new string('x', 5000)), "log");
        Assert.True(text.Length < 2000);
        Assert.Contains("…", text);
    }

    [Fact]
    public void DescribeToleratesAnEmptyMessage()
    {
        var text = CrashGuard.Describe(new InvalidOperationException(), "log");
        Assert.Contains("InvalidOperationException", text);
    }

    [Fact]
    public void ReportLogsAndShowsTheDialogOnce()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-crash-" + Guid.NewGuid().ToString("N"));
        var log = Path.Combine(root, "client.log");
        try
        {
            var shown = new List<string>();
            CrashGuard.Report(new InvalidOperationException("boom"), log, shown.Add);

            Assert.Single(shown);
            Assert.Contains("boom", shown[0]);
            Assert.True(File.Exists(log));
            Assert.Contains("unhandled exception", File.ReadAllText(log));
            Assert.Contains("boom", File.ReadAllText(log));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void AFailingDialogDoesNotBecomeASecondUnhandledException()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-crash-" + Guid.NewGuid().ToString("N"));
        try
        {
            CrashGuard.Report(new InvalidOperationException("boom"),
                Path.Combine(root, "client.log"),
                _ => throw new InvalidOperationException("dialog failed"));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void ReportSurvivesAnUnwritableLogPath()
    {
        // The dialog still helps even when the log cannot be written.
        var shown = new List<string>();
        var unwritable = Path.Combine(Path.GetTempPath(), "dsh-win-\0bad", "client.log");
        CrashGuard.Report(new InvalidOperationException("boom"), unwritable, shown.Add);
        Assert.Single(shown);
    }

    [Fact]
    public void TitleIsUserFacing()
    {
        Assert.False(string.IsNullOrWhiteSpace(CrashGuard.Title));
        Assert.Contains("未预期", CrashGuard.Title);
    }
}
