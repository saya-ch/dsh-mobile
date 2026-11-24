using System.IO;
using System.Text;

namespace DshMobile.Win;

/// <summary>
/// Last-resort handling for exceptions nobody caught, so the client reports a problem
/// instead of vanishing.
/// </summary>
/// <remarks>
/// A WPF window that throws on the UI thread without a handler terminates the process
/// with no message: the portable client simply closed. Both unhandled-exception sources
/// (the dispatcher and the AppDomain) now route here, which logs the full exception
/// beside the other diagnostics and shows one readable dialog. The handler is
/// re-entrancy guarded: an exception thrown by the dialog itself must not recurse.
/// </remarks>
internal static class CrashGuard
{
    internal const string Title = "程序遇到未预期的问题";

    private static int _showing;

    /// <summary>Path of the log next to the executable, independent of window state.</summary>
    internal static string DefaultLogPath(string baseDirectory) =>
        Path.Combine(baseDirectory, "data", "client.log");

    /// <summary>Short, user-facing text; the full exception goes to the log.</summary>
    internal static string Describe(Exception error, string logPath)
    {
        var detail = error is AggregateException aggregate && aggregate.InnerException is not null
            ? aggregate.InnerException
            : error;
        var message = detail.Message.Trim();
        if (message.Length > 400) message = message[..400] + "…";
        var builder = new StringBuilder();
        builder.Append("程序遇到未预期的问题，但已阻止直接退出。\n\n");
        builder.Append(detail.GetType().Name);
        if (message.Length > 0) builder.Append("：").Append(message);
        builder.Append("\n\n详细信息已写入：\n").Append(logPath);
        builder.Append("\n\n如果问题反复出现，请把该日志附在 issue 里。");
        return builder.ToString();
    }

    /// <summary>Log the exception and show one dialog; never throws.</summary>
    internal static void Report(Exception error, string logPath, Action<string> showDialog)
    {
        try
        {
            ClientLog.Write(logPath, "unhandled exception: " + error);
        }
        catch
        {
            // Logging itself failed; the dialog still helps.
        }
        if (Interlocked.Exchange(ref _showing, 1) == 1) return;
        try
        {
            showDialog(Describe(error, logPath));
        }
        catch
        {
            // A failing dialog must not become a second unhandled exception.
        }
        finally
        {
            Interlocked.Exchange(ref _showing, 0);
        }
    }
}
