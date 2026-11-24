using System.IO;

namespace DshMobile.Win;

/// <summary>
/// Append-only client log with a hard size cap.
/// </summary>
/// <remarks>
/// The portable client used to append forever: a long-running install grew
/// <c>data\client.log</c> without limit, and a folder on a small USB stick could fill up.
/// Once the live file reaches <see cref="MaxBytes"/> it is rotated to
/// <c>client.log.1</c> (replacing the previous generation) and a fresh file is started,
/// so the folder holds at most two files of that size. Logging never throws: a
/// read-only folder or a full disk must not turn into an application error.
/// </remarks>
internal static class ClientLog
{
    /// <summary>Rotate once the live log reaches 2 MB.</summary>
    internal const long MaxBytes = 2L * 1024 * 1024;

    private static readonly object Gate = new();

    /// <summary>The single kept generation, beside the live file.</summary>
    internal static string RotatedPath(string path) => path + ".1";

    /// <summary>Pure size decision, so the threshold is unit-testable.</summary>
    internal static bool ShouldRotate(long currentLength) => currentLength >= MaxBytes;

    internal static void Write(string path, string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {message}";
        try
        {
            lock (Gate)
            {
                var directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                RotateIfNeeded(path);
                File.AppendAllText(path, line + Environment.NewLine);
            }
        }
        catch
        {
            // Read-only folder, full disk or a locked file: diagnostics are best effort.
        }
    }

    private static void RotateIfNeeded(string path)
    {
        FileInfo info;
        try { info = new FileInfo(path); }
        catch { return; }
        if (!info.Exists || !ShouldRotate(info.Length)) return;
        try
        {
            File.Move(path, RotatedPath(path), overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Another process holds the file open; keep appending rather than losing lines.
        }
    }
}
