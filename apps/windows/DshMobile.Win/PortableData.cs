using System.IO;
using DshMobile.Win.Resources;

namespace DshMobile.Win;

/// <summary>
/// Prepares the portable <c>data\</c> folder that holds settings, the paired-device
/// list and the log.
/// </summary>
/// <remarks>
/// The client writes everything beside the executable. Unzipped under
/// <c>Program Files</c> the folder exists but refuses new files, so
/// <see cref="Directory.CreateDirectory"/> alone is not proof that it is usable: the
/// probe writes one tiny file. Callers turn a failure into a single actionable
/// message instead of an unhandled exception during construction.
/// </remarks>
internal static class PortableData
{
    internal static string UnwritableTitle => Strings.AppData_UnwritableTitle;

    internal static string UnwritableMessage => Strings.AppData_UnwritableMessage;

    internal const string ProbeFileName = ".write-probe";

    /// <summary>
    /// Creates the folder and proves it accepts a new file.
    /// Returns false with a diagnostic message when the folder cannot be used.
    /// </summary>
    internal static bool TryPrepare(string root, out string? error)
    {
        error = null;
        try
        {
            Directory.CreateDirectory(root);
            var probe = Path.Combine(root, ProbeFileName);
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or NotSupportedException
            or ArgumentException
            or System.Security.SecurityException)
        {
            error = exception.Message;
            return false;
        }
    }
}
