using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;

namespace DshMobile.Win;

/// <summary>Which step of the update the settings page is reporting.</summary>
internal enum UpdateStage
{
    Download,
    Verify,
    Launch,
}

/// <summary>One progress report: bytes so far and the total when the server declared it.</summary>
internal sealed record UpdateProgress(UpdateStage Stage, long Received, long? Total)
{
    /// <summary>Percent complete, or null when the transfer size is unknown.</summary>
    internal double? Percent => Total is { } total && total > 0
        ? Math.Clamp(Received * 100.0 / total, 0, 100)
        : null;
}

/// <summary>
/// A failed step, already phrased for the user: Chinese, and saying what to do next.
/// </summary>
/// <param name="Detail">The underlying exception text, shown under the message for support.</param>
/// <param name="Cancelled">True when the user stopped it, which is not an error.</param>
internal sealed record UpdateFailure(string Message, string? Detail = null, bool Cancelled = false);

/// <summary>A downloaded file on disk.</summary>
internal sealed record UpdateDownload(string Path, long Bytes);

internal sealed record DownloadOutcome(UpdateDownload? File, UpdateFailure? Failure)
{
    internal bool Ok => File is not null && Failure is null;
}

internal sealed record UpdateOutcome(bool Started, UpdateFailure? Failure)
{
    internal bool Ok => Started && Failure is null;
}

/// <summary>Deadlines for one transfer: the whole download and any single idle read.</summary>
/// <remarks>
/// Both exist because a 49 MB installer over a slow link is legitimate, while a stalled
/// socket is not: a fixed <see cref="HttpClient.Timeout"/> cannot tell those apart, so the
/// overall budget bounds the transfer and the stall budget bounds one read.
/// </remarks>
internal sealed record DownloadBudget(TimeSpan Overall, TimeSpan Stall)
{
    internal static DownloadBudget Default { get; } = new(TimeSpan.FromMinutes(10), TimeSpan.FromSeconds(20));
}

/// <summary>Starts the downloaded installer. Replaced in tests so no real setup ever runs.</summary>
internal delegate void InstallerLauncher(string executablePath, string arguments);

/// <summary>
/// File-level knowledge the update flow needs: names, digests, sizes and the installer's
/// own switches. Pure functions, so every rule here is unit-tested without a network.
/// </summary>
internal static class UpdatePayload
{
    /// <summary>Suffix of the installer asset published by the Windows release workflow.</summary>
    internal const string SetupSuffix = "-setup.exe";

    /// <summary>Suffix of that installer's checksum sidecar.</summary>
    internal const string ChecksumSuffix = "-setup.exe.sha256";

    /// <summary>Longest sidecar accepted before it stops looking like a checksum file.</summary>
    internal const int MaxChecksumBytes = 4096;

    /// <summary>
    /// The first SHA-256 digest found in a <c>.sha256</c> sidecar, lowercased.
    /// </summary>
    /// <remarks>
    /// The workflow writes <c>"&lt;hex&gt;  &lt;name&gt;"</c> (the <c>sha256sum</c> format), so the
    /// digest is matched anywhere in the text instead of by line shape: some tools prefix
    /// binary mode with <c>*</c>, some emit only the bare digest.
    /// </remarks>
    internal static string? ParseChecksum(string? sidecarText)
    {
        if (string.IsNullOrWhiteSpace(sidecarText)) return null;
        foreach (var token in sidecarText.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = token.Trim().TrimStart('*');
            var digest = NormalizeDigest(candidate);
            if (digest is not null) return digest;
        }
        return null;
    }

    /// <summary>A digest as lowercase hex, or null when the value is not one.</summary>
    internal static string? NormalizeDigest(string? value)
    {
        if (value is null) return null;
        var trimmed = value.Trim();
        return trimmed.Length == 64 && trimmed.All(char.IsAsciiHexDigit)
            ? trimmed.ToLowerInvariant()
            : null;
    }

    /// <summary>
    /// Whether the downloaded file's digest equals the published one. An unparsable value
    /// on either side is a mismatch: the security boundary never installs on a guess.
    /// </summary>
    internal static bool Matches(string? expected, string? actual)
    {
        var left = NormalizeDigest(expected);
        var right = NormalizeDigest(actual);
        return left is not null && right is not null && string.Equals(left, right, StringComparison.Ordinal);
    }

    /// <summary>SHA-256 of a stream, as lowercase hex.</summary>
    internal static async Task<string> ComputeSha256Async(Stream stream, CancellationToken ct)
    {
        var digest = await SHA256.HashDataAsync(stream, ct).ConfigureAwait(false);
        return Convert.ToHexString(digest).ToLowerInvariant();
    }

    /// <summary>SHA-256 of a file, as lowercase hex.</summary>
    internal static async Task<string> ComputeFileSha256Async(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true);
        return await ComputeSha256Async(stream, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// A file name that cannot leave the directory it is created in.
    /// </summary>
    /// <remarks>
    /// The name comes from a download URL, so it is untrusted: only the last path segment
    /// survives and only <c>[A-Za-z0-9._-]</c> characters are kept. A value that reduces to
    /// nothing (or to <c>.</c>/<c>..</c>, which is how a path escapes) falls back to
    /// <paramref name="fallback"/>.
    /// </remarks>
    internal static string SafeFileName(string? name, string fallback = "update.bin")
    {
        if (string.IsNullOrWhiteSpace(name)) return fallback;
        var leaf = name.Trim();
        var separator = leaf.LastIndexOfAny(['\\', '/', ':']);
        if (separator >= 0) leaf = leaf[(separator + 1)..];
        var cleaned = new string(leaf
            .Where(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_' or '.')
            .ToArray())
            .TrimStart('.');
        return cleaned.Length == 0 ? fallback : cleaned;
    }

    /// <summary>A byte count for the progress row ("49.0 MB").</summary>
    internal static string DescribeSize(long bytes)
    {
        if (bytes < 0) return "未知大小";
        if (bytes < 1024) return bytes.ToString(CultureInfo.InvariantCulture) + " B";
        var value = bytes / 1024.0;
        if (value < 1024) return value.ToString("0.0", CultureInfo.InvariantCulture) + " KB";
        value /= 1024.0;
        if (value < 1024) return value.ToString("0.0", CultureInfo.InvariantCulture) + " MB";
        return (value / 1024.0).ToString("0.00", CultureInfo.InvariantCulture) + " GB";
    }

    /// <summary>What the progress row says for one report.</summary>
    internal static string DescribeProgress(UpdateProgress progress) => progress.Stage switch
    {
        UpdateStage.Download when progress.Percent is { } percent && progress.Total is { } total =>
            $"{DescribeSize(progress.Received)} / {DescribeSize(total)}（{percent.ToString("0", CultureInfo.InvariantCulture)}%）",
        UpdateStage.Download => "已下载 " + DescribeSize(progress.Received),
        UpdateStage.Verify => "正在校验 SHA-256…",
        _ => "正在启动安装程序…",
    };

    /// <summary>
    /// The switches handed to the Inno Setup installer for an unattended upgrade.
    /// </summary>
    /// <remarks>
    /// <c>/SILENT</c> drops the wizard but keeps Inno's own installation-progress window
    /// and its error dialogs: this process exits before the files are replaced, so the
    /// installer's window is the only feedback the user has for a 49 MB extraction.
    /// <c>/VERYSILENT</c> would remove exactly that, and <c>/SUPPRESSMSGBOXES</c> would
    /// hide a real failure, so neither is used.
    /// <para>
    /// <c>/DIR</c> pins the upgrade to the folder this process runs from. Without it a
    /// portable copy would gain a second, empty installation under
    /// <c>%LocalAppData%\Programs\DshMobile</c> while the pairings in its own
    /// <c>data\</c> stayed behind with the old binary.
    /// </para>
    /// <para>
    /// <c>/NORESTARTAPPLICATIONS</c> keeps the restart deterministic: this process is
    /// already exiting, so Inno's Restart Manager would relaunch the client only in the
    /// race where it closes the process itself. <c>/NORESTART</c> never reboots the
    /// machine, <c>/SP-</c> skips the "this will install" prompt, and
    /// <c>/CLOSEAPPLICATIONS</c> lets the installer close anything still holding the
    /// files it must replace (the .iss already sets <c>CloseApplications=yes</c>).
    /// Inno's [Files] section never touches <c>data\</c>, so pairings, settings and logs
    /// survive the replacement.
    /// </para>
    /// </remarks>
    internal static string SilentInstallArguments(string installDirectory)
    {
        var directory = string.IsNullOrWhiteSpace(installDirectory)
            ? AppContext.BaseDirectory
            : installDirectory.Trim();
        // A trailing separator would escape the closing quote.
        directory = Path.TrimEndingDirectorySeparator(directory);
        return "/SILENT /SP- /NORESTART /NORESTARTAPPLICATIONS /CLOSEAPPLICATIONS " +
               "/DIR=\"" + directory + "\"";
    }

    /// <summary>Why the release lookup failed, in user-facing Chinese.</summary>
    internal static string DescribeCheckFailure(Exception error) => error switch
    {
        TaskCanceledException => "请求超时（15 秒内没有响应）",
        HttpRequestException => "无法连接 GitHub",
        _ => string.IsNullOrWhiteSpace(error.Message) ? "未知错误" : error.Message,
    };
}

/// <summary>
/// Downloads, verifies and starts the Windows client installer.
/// </summary>
/// <remarks>
/// The pipeline is download → fetch the published digest → compare → start the installer,
/// and it stops at the first failure with Chinese copy that names the next action. A
/// digest that cannot be fetched, parsed or matched deletes the download and never runs
/// it; that check is the only thing standing between the user and a tampered executable,
/// so it is not skippable and not a warning.
/// <para>
/// The launcher is a constructor dependency, so the test project can prove the last step
/// happens (or does not) without ever starting a real setup program.
/// </para>
/// </remarks>
internal sealed class UpdateInstaller
{
    private readonly HttpClient _client;
    private readonly InstallerLauncher _launcher;
    private readonly DownloadBudget _budget;
    private readonly string _tempRoot;

    internal UpdateInstaller(
        HttpClient client,
        InstallerLauncher? launcher = null,
        DownloadBudget? budget = null,
        string? tempRoot = null)
    {
        _client = client;
        _launcher = launcher ?? StartInstaller;
        _budget = budget ?? DownloadBudget.Default;
        _tempRoot = tempRoot ?? Path.Combine(Path.GetTempPath(), "dsh-mobile-updates");
    }

    /// <summary>The default launcher: start the installer and let it outlive this process.</summary>
    internal static void StartInstaller(string executablePath, string arguments)
    {
        var start = new ProcessStartInfo(executablePath, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(executablePath) ?? Path.GetTempPath(),
        };
        // The installer must survive this process, so the handle is dropped at once
        // instead of being waited on.
        using var process = Process.Start(start)
            ?? throw new InvalidOperationException("未能启动安装程序进程。");
    }

    /// <summary>
    /// Run the whole update for <paramref name="release"/>; the caller exits the process
    /// when <see cref="UpdateOutcome.Started"/> is true.
    /// </summary>
    internal async Task<UpdateOutcome> InstallAsync(
        WindowsRelease release,
        string installDirectory,
        IProgress<UpdateProgress>? progress,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(release.SetupUrl))
        {
            return Failed(new UpdateFailure(
                $"版本 {release.Version} 没有提供安装包，无法自动更新。请手动下载：" + UpdateCheck.ReleasesPage));
        }
        if (!Uri.TryCreate(release.SetupUrl, UriKind.Absolute, out var setupUri))
        {
            return Failed(new UpdateFailure(
                $"版本 {release.Version} 的安装包地址无效，请手动下载：" + UpdateCheck.ReleasesPage));
        }
        if (!Uri.TryCreate(release.SetupChecksumUrl, UriKind.Absolute, out var checksumUri))
        {
            return Failed(new UpdateFailure(
                $"版本 {release.Version} 缺少 SHA-256 校验文件，无法确认安装包完整性，已取消安装。" +
                "请手动下载：" + UpdateCheck.ReleasesPage));
        }

        var directory = Path.Combine(_tempRoot, UpdatePayload.SafeFileName("v" + release.Version, "update"));
        try
        {
            // A clean folder per update: a leftover partial file must never be mistaken
            // for the payload of this run.
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
            Directory.CreateDirectory(directory);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return Failed(new UpdateFailure("无法创建临时下载目录：" + directory, error.Message));
        }

        progress?.Report(new UpdateProgress(UpdateStage.Download, 0, null));
        var fileName = UpdatePayload.SafeFileName(Path.GetFileName(setupUri.LocalPath), "setup.exe");
        var download = await DownloadAsync(setupUri, directory, fileName, progress, ct).ConfigureAwait(false);
        if (download.Failure is { } downloadFailure) return Failed(downloadFailure);
        var file = download.File!;

        var checksum = await DownloadTextAsync(checksumUri, ct).ConfigureAwait(false);
        if (checksum.Failure is { } checksumFailure)
        {
            Delete(file.Path);
            return Failed(checksumFailure);
        }

        progress?.Report(new UpdateProgress(UpdateStage.Verify, file.Bytes, file.Bytes));
        UpdateFailure? verifyFailure;
        try
        {
            verifyFailure = await VerifyAsync(file.Path, checksum.Text, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException error)
        {
            Delete(file.Path);
            return Failed(Stopped(ct, "校验", error));
        }
        if (verifyFailure is not null)
        {
            Delete(file.Path);
            return Failed(verifyFailure);
        }

        progress?.Report(new UpdateProgress(UpdateStage.Launch, file.Bytes, file.Bytes));
        try
        {
            _launcher(file.Path, UpdatePayload.SilentInstallArguments(installDirectory));
        }
        catch (Exception error)
        {
            // The verified package is kept on purpose: the message tells the user to run it.
            return Failed(new UpdateFailure(
                "无法启动安装程序。安装包已下载并校验通过，可手动运行：" + file.Path, error.Message));
        }
        return new UpdateOutcome(true, null);
    }

    /// <summary>
    /// Compare a downloaded file with the published <c>.sha256</c> sidecar; null means it
    /// may be installed.
    /// </summary>
    internal static async Task<UpdateFailure?> VerifyAsync(string filePath, string? checksumText, CancellationToken ct)
    {
        var expected = UpdatePayload.ParseChecksum(checksumText);
        if (expected is null)
        {
            return new UpdateFailure(
                "校验失败：校验文件里没有可解析的 SHA-256 值，已取消安装。请手动下载：" + UpdateCheck.ReleasesPage);
        }
        string actual;
        try
        {
            actual = await UpdatePayload.ComputeFileSha256Async(filePath, ct).ConfigureAwait(false);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return new UpdateFailure("校验失败：无法读取已下载的安装包，已取消安装。", error.Message);
        }
        if (UpdatePayload.Matches(expected, actual)) return null;
        return new UpdateFailure(
            "校验失败：安装包的 SHA-256 与发布值不一致，已删除下载的文件并且没有安装。" +
            "\n发布值：" + expected + "\n实际值：" + actual +
            "\n请重试；若仍不一致，请手动下载：" + UpdateCheck.ReleasesPage);
    }

    /// <summary>
    /// Stream <paramref name="url"/> into <paramref name="directory"/>.
    /// </summary>
    /// <remarks>
    /// Writes <c>&lt;name&gt;.part</c> and renames on success, so an interrupted transfer
    /// can never be picked up as a complete file. A body that ends before its declared
    /// length is a failure too (<see cref="UpdateFailure"/> "下载中断"), because a truncated
    /// executable would otherwise fail the digest check one step later with a much less
    /// useful message.
    /// </remarks>
    internal async Task<DownloadOutcome> DownloadAsync(
        Uri url,
        string directory,
        string fileName,
        IProgress<UpdateProgress>? progress,
        CancellationToken ct)
    {
        var path = Path.Combine(directory, fileName);
        var partial = path + ".part";
        var complete = false;
        FileStream? target = null;
        try
        {
            Directory.CreateDirectory(directory);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(_budget.Overall);
            using var response = await _client
                .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, deadline.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return new DownloadOutcome(null, HttpFailure(response.StatusCode, url));

            var total = response.Content.Headers.ContentLength;
            using var source = await response.Content.ReadAsStreamAsync(deadline.Token).ConfigureAwait(false);
            target = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true);

            var buffer = new byte[81920];
            long received = 0;
            while (true)
            {
                int read;
                // A fresh linked source per read so the stall budget restarts for every
                // chunk instead of covering the whole transfer.
                using (var stall = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token))
                {
                    stall.CancelAfter(_budget.Stall);
                    try
                    {
                        read = await source.ReadAsync(buffer, stall.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException error)
                    {
                        return new DownloadOutcome(null, Stopped(ct, "下载", error));
                    }
                }
                if (read == 0) break;
                await target.WriteAsync(buffer.AsMemory(0, read), deadline.Token).ConfigureAwait(false);
                received += read;
                progress?.Report(new UpdateProgress(UpdateStage.Download, received, total));
            }

            await target.FlushAsync(deadline.Token).ConfigureAwait(false);
            await target.DisposeAsync().ConfigureAwait(false);
            target = null;
            if (total is { } declared && received != declared)
            {
                return new DownloadOutcome(null, new UpdateFailure(
                    $"下载中断：只收到 {UpdatePayload.DescribeSize(received)}，" +
                    $"应为 {UpdatePayload.DescribeSize(declared)}。请重试，或手动下载：{UpdateCheck.ReleasesPage}"));
            }
            File.Move(partial, path, overwrite: true);
            complete = true;
            return new DownloadOutcome(new UpdateDownload(path, received), null);
        }
        catch (OperationCanceledException error)
        {
            return new DownloadOutcome(null, Stopped(ct, "下载", error));
        }
        catch (HttpRequestException error)
        {
            return new DownloadOutcome(null, NetworkFailure(error));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return new DownloadOutcome(null, new UpdateFailure(
                "下载失败：无法写入临时目录 " + directory + "。请检查磁盘空间与权限，或手动下载：" +
                UpdateCheck.ReleasesPage, error.Message));
        }
        finally
        {
            if (target is not null) await target.DisposeAsync().ConfigureAwait(false);
            if (!complete) Delete(partial);
        }
    }

    /// <summary>Fetch a small text file (the checksum sidecar) with the same deadlines.</summary>
    private async Task<(string? Text, UpdateFailure? Failure)> DownloadTextAsync(Uri url, CancellationToken ct)
    {
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(_budget.Overall);
            using var response = await _client
                .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, deadline.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return (null, HttpFailure(response.StatusCode, url));
            if (response.Content.Headers.ContentLength is > UpdatePayload.MaxChecksumBytes)
                return (null, OversizedChecksum());
            var text = await response.Content.ReadAsStringAsync(deadline.Token).ConfigureAwait(false);
            return text.Length > UpdatePayload.MaxChecksumBytes ? (null, OversizedChecksum()) : (text, null);
        }
        catch (OperationCanceledException error)
        {
            return (null, Stopped(ct, "下载校验文件", error));
        }
        catch (HttpRequestException error)
        {
            return (null, NetworkFailure(error));
        }
    }

    private static UpdateFailure OversizedChecksum() => new(
        "校验失败：校验文件大小异常（不像 SHA-256 文件），已取消安装。请手动下载：" + UpdateCheck.ReleasesPage);

    private static UpdateFailure HttpFailure(HttpStatusCode status, Uri url)
    {
        var code = (int)status;
        var reason = status switch
        {
            HttpStatusCode.NotFound => "发布资产不存在（HTTP 404）",
            HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests => "GitHub 拒绝了本次请求（HTTP " + code + "），请稍后重试",
            HttpStatusCode.Moved or HttpStatusCode.Redirect => "下载地址已变更（HTTP " + code + "）",
            _ => "服务器返回 HTTP " + code,
        };
        return new UpdateFailure(
            "下载失败：" + reason + "。请检查网络后重试，或手动下载：" + UpdateCheck.ReleasesPage, url.ToString());
    }

    private static UpdateFailure NetworkFailure(Exception error) => new(
        "下载失败：网络连接中断或无法访问 GitHub。请检查网络（或代理）后重试，或手动下载：" +
        UpdateCheck.ReleasesPage, error.Message);

    /// <summary>Distinguishes "the user stopped it" from "the deadline expired".</summary>
    private static UpdateFailure Stopped(CancellationToken userToken, string step, Exception error) =>
        userToken.IsCancellationRequested
            ? new UpdateFailure("已取消更新，未做任何更改。", Cancelled: true)
            : new UpdateFailure(
                step + "超时（网络长时间无响应），请检查网络后重试，或手动下载：" + UpdateCheck.ReleasesPage,
                error.Message);

    private static UpdateOutcome Failed(UpdateFailure failure) => new(false, failure);

    /// <summary>
    /// Best-effort delete of a download; a file the user or an antivirus holds open must
    /// not turn a verification failure into a crash.
    /// </summary>
    private static void Delete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Nothing else to do: the file is in %TEMP% and is replaced on the next run.
        }
    }
}
