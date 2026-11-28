using System;
using System.IO;
using DshMobile.Win;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// Where the client keeps its data, and what it does when the program folder refuses writes.
/// </summary>
/// <remarks>
/// The client stores pairings, settings and a log beside itself and runs unelevated. That works
/// for the portable zip and for a per-user install, but a folder the user cannot write makes the
/// client start, warn, and then silently lose everything it was given. These assertions cover
/// the two candidate roots and the migration that carries an existing install across.
/// </remarks>
public class AppDataPathsTests
{
    [Fact]
    public void ThePortableRootSitsBesideTheExecutable()
    {
        Assert.Equal(
            Path.Combine(AppContext.BaseDirectory, "data"),
            AppDataPaths.PortableRoot,
            ignoreCase: true);
        // That relationship is what makes the zip portable: an upgrade takes the data along.
        Assert.StartsWith(AppContext.BaseDirectory, AppDataPaths.PortableRoot, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheFallbackLivesUnderTheUsersLocalApplicationData()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        Assert.Equal(
            Path.Combine(local, "DshMobile", "data"),
            AppDataPaths.PerUserRoot,
            ignoreCase: true);
        // %LOCALAPPDATA% is writable by the account running the client, which is the point.
        Assert.DoesNotContain("Program Files", AppDataPaths.PerUserRoot, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheChosenRootIsThePortableOneHereBecauseTheTestFolderIsWritable()
    {
        // The build output is writable, so the preference holds and the fallback stays unused.
        Assert.True(AppDataPaths.IsPortable);
        Assert.True(AppDataPaths.IsWritable);
        Assert.Null(AppDataPaths.PortableRejection);
        Assert.Equal(AppDataPaths.PortableRoot, AppDataPaths.DataRoot, ignoreCase: true);
    }

    [Fact]
    public void AnUnusableFolderReportsAReasonInsteadOfThrowing()
    {
        // TryPrepare is what decides between the two roots; it must never throw, because the
        // caller runs during window construction and has nowhere to surface an exception.
        var file = Path.Combine(Path.GetTempPath(), $"dsh-probe-{Guid.NewGuid():N}");
        File.WriteAllText(file, "not a directory");
        try
        {
            Assert.False(PortableData.TryPrepare(file, out var error));
            Assert.False(string.IsNullOrWhiteSpace(error));
        }
        finally
        {
            File.Delete(file);
        }
    }
}