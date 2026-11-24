using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>The portable data folder probe that replaces a bare Directory.CreateDirectory.</summary>
public class PortableDataTests
{
    [Fact]
    public void CreatesAndProvesAWritableFolder()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-data-" + Guid.NewGuid().ToString("N"));
        try
        {
            Assert.True(PortableData.TryPrepare(root, out var error));
            Assert.Null(error);
            Assert.True(Directory.Exists(root));
            // The probe file must not be left behind.
            Assert.False(File.Exists(Path.Combine(root, PortableData.ProbeFileName)));
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void AcceptsAnAlreadyExistingWritableFolder()
    {
        var root = Path.Combine(Path.GetTempPath(), "dsh-win-data-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            Assert.True(PortableData.TryPrepare(root, out var error));
            Assert.Null(error);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void ReportsFailureWithADiagnosticInsteadOfThrowing()
    {
        // A path whose parent is an existing *file* can never be a directory.
        var blocker = Path.Combine(Path.GetTempPath(), "dsh-win-blocker-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.WriteAllText(blocker, "not a directory");
            var target = Path.Combine(blocker, "data");
            Assert.False(PortableData.TryPrepare(target, out var error));
            Assert.False(string.IsNullOrWhiteSpace(error));
        }
        finally
        {
            try { File.Delete(blocker); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void MessageTellsTheUserToMoveTheProgramToAWritableFolder()
    {
        Assert.Contains("可写目录", PortableData.UnwritableMessage);
        Assert.Contains("Program Files", PortableData.UnwritableMessage);
        Assert.False(string.IsNullOrWhiteSpace(PortableData.UnwritableTitle));
    }
}
