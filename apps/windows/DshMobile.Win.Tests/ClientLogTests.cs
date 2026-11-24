using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>Log rotation: the live file is capped at 2 MB with one kept generation.</summary>
public class ClientLogTests
{
    [Fact]
    public void RotatesAtTwoMegabytes()
    {
        Assert.Equal(2L * 1024 * 1024, ClientLog.MaxBytes);
    }

    [Theory]
    [InlineData(0L, false)]
    [InlineData(1024L, false)]
    [InlineData(2L * 1024 * 1024 - 1, false)]
    [InlineData(2L * 1024 * 1024, true)]        // at the cap
    [InlineData(2L * 1024 * 1024 + 1, true)]    // past the cap
    [InlineData(50L * 1024 * 1024, true)]
    public void ShouldRotateOnlyAtOrPastTheCap(long length, bool expected)
    {
        Assert.Equal(expected, ClientLog.ShouldRotate(length));
    }

    [Fact]
    public void RotatedFileSitsBesideTheLiveOne()
    {
        var live = Path.Combine(Path.GetTempPath(), "dsh-test", "client.log");
        Assert.Equal(live + ".1", ClientLog.RotatedPath(live));
    }

    [Fact]
    public void WritesToACreatedFolderAndKeepsTheMessage()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-log-" + Guid.NewGuid().ToString("N"));
        var log = Path.Combine(root, "client.log");
        try
        {
            ClientLog.Write(log, "first line");
            ClientLog.Write(log, "second line");
            var text = File.ReadAllText(log);
            Assert.Contains("first line", text);
            Assert.Contains("second line", text);
            Assert.False(File.Exists(ClientLog.RotatedPath(log)));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void RotatesAnOversizedFileAndKeepsExactlyOneGeneration()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-log-" + Guid.NewGuid().ToString("N"));
        var log = Path.Combine(root, "client.log");
        var rotated = ClientLog.RotatedPath(log);
        try
        {
            Directory.CreateDirectory(root);
            // Pre-seed an oversized live file and an older generation.
            File.WriteAllText(log, new string('a', (int)ClientLog.MaxBytes + 1));
            File.WriteAllText(rotated, "generation 1");

            ClientLog.Write(log, "after rotation");

            Assert.True(File.Exists(log));
            Assert.True(File.Exists(rotated));
            // The oversized file became the kept generation; the previous one is gone.
            Assert.Contains("after rotation", File.ReadAllText(log));
            Assert.DoesNotContain("generation 1", File.ReadAllText(rotated));
            Assert.True(new FileInfo(rotated).Length > ClientLog.MaxBytes);
            Assert.True(new FileInfo(log).Length < ClientLog.MaxBytes);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void TwoWritesAfterTheCapLeaveOnlyTwoFiles()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-log-" + Guid.NewGuid().ToString("N"));
        var log = Path.Combine(root, "client.log");
        try
        {
            Directory.CreateDirectory(root);
            File.WriteAllText(log, new string('b', (int)ClientLog.MaxBytes));
            ClientLog.Write(log, "one");
            File.WriteAllText(log, new string('c', (int)ClientLog.MaxBytes));
            ClientLog.Write(log, "two");

            var files = Directory.GetFiles(root, "client.log*");
            Assert.Equal(2, files.Length);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void WriteNeverThrowsOnAnUnusablePath()
    {
        // A directory that cannot exist as a file target: logging must stay best-effort.
        var path = Path.Combine(Path.GetTempPath(), "dsh-win-log-" + Guid.NewGuid().ToString("N"), "a\0b");
        ClientLog.Write(path, "must not throw");
    }
}
