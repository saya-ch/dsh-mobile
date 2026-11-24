using System.IO;

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
    internal const string UnwritableTitle = "程序目录不可写";

    internal const string UnwritableMessage =
        "程序目录不可写，设置、已配对电脑与日志都无法保存。\n\n" +
        "请把整个程序文件夹放到可写目录（例如桌面、文档或 U 盘）后重新运行；" +
        "不要放在 Program Files 等需要管理员权限的位置。\n\n" +
        "本次运行仍可连接电脑，但退出后不会保留任何设置。";

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
