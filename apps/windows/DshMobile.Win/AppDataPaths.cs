using System;
using System.IO;

namespace DshMobile.Win;

/// <summary>
/// Where the client keeps its data, chosen once per process.
/// </summary>
/// <remarks>
/// The portable build keeps everything beside the executable, which is the whole point of the
/// zip: unzip it anywhere writable and the pairings travel with it. That is the preferred
/// layout and it is what the installer produces too, because it installs per-user into
/// <c>%LocalAppData%\Programs</c>.
///
/// It cannot be assumed, though. The installer's directory page lets the user choose any path,
/// and an older per-machine install still lives under <c>%ProgramFiles%</c>; there
/// <c>&lt;install&gt;\data</c> exists but refuses new files for a normal user, and the client
/// would start, show its warning, and then quietly lose every pairing and setting it was given.
///
/// So the folder is probed rather than assumed, and an unwritable program folder falls back to
/// the user's own local application data. That is the same arrangement Android gives an app:
/// its files live in a per-app directory that does not move when the app does. Existing data
/// beside the executable is copied across on the way, so an upgrade keeps its pairings.
/// </remarks>
internal static class AppDataPaths
{
    private const string AppFolderName = "DshMobile";

    private static readonly Lazy<string> resolved = new(Resolve, isThreadSafe: true);

    /// <summary>Files worth carrying over from a read-only program folder.</summary>
    private static readonly string[] migratedFiles = { "settings.json", "devices.json" };

    /// <summary>The data folder this process uses.</summary>
    internal static string DataRoot => resolved.Value;

    /// <summary>True when the program folder itself is writable, so data still travels with it.</summary>
    internal static bool IsPortable
    {
        get { _ = resolved.Value; return isPortable; }
    }

    /// <summary>Why the program folder was rejected, for the log.</summary>
    internal static string? PortableRejection
    {
        get { _ = resolved.Value; return rejection; }
    }

    /// <summary>True when the chosen folder accepts new files.</summary>
    internal static bool IsWritable
    {
        get { _ = resolved.Value; return writable; }
    }

    private static bool isPortable;
    private static bool writable;
    private static string? rejection;

    /// <summary>The program folder's <c>data</c>, whether or not it is used.</summary>
    internal static string PortableRoot => Path.Combine(AppContext.BaseDirectory, "data");

    /// <summary>The per-user fallback, whether or not it is used.</summary>
    internal static string PerUserRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        AppFolderName,
        "data");

    private static string Resolve()
    {
        // Keep the portable layout when it works: unzipped into a writable place, the data
        // stays with the executable and an upgrade or a move takes it along.
        if (PortableData.TryPrepare(PortableRoot, out var portableError))
        {
            isPortable = true;
            writable = true;
            return PortableRoot;
        }

        rejection = portableError;
        // An installed copy under Program Files lands here. The user's own directory is always
        // writable by the account running the client.
        var perUser = PerUserRoot;
        if (PortableData.TryPrepare(perUser, out var perUserError))
        {
            writable = true;
            MigratePortableData(perUser);
            return perUser;
        }

        // Both refused: keep going with the intended path so the caller can still report a
        // single actionable failure instead of an exception during construction.
        writable = false;
        rejection ??= perUserError;
        return perUser;
    }

    /// <summary>
    /// Copy settings and pairings from a read-only program folder into the per-user folder.
    /// </summary>
    /// <remarks>
    /// Copies rather than moves: the source may be a system directory the process cannot write,
    /// and leaving it in place costs nothing while making a downgrade recoverable. The WebView
    /// profile and the log are deliberately skipped — one is a large cache that rebuilds
    /// itself, the other is history rather than state.
    /// </remarks>
    private static void MigratePortableData(string target)
    {
        foreach (var name in migratedFiles)
        {
            try
            {
                var source = Path.Combine(PortableRoot, name);
                var destination = Path.Combine(target, name);
                if (File.Exists(source) && !File.Exists(destination))
                {
                    File.Copy(source, destination);
                }
            }
            catch (Exception exception) when (exception is IOException
                or UnauthorizedAccessException
                or System.Security.SecurityException)
            {
                // A half-migrated folder still beats refusing to start; the file that could
                // not be copied is simply re-created the next time the user changes something.
            }
        }
    }
}