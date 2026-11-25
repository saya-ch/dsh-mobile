using System.Net;
using System.Net.Http;
using System.Text;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// The update pipeline's rules: digest parsing/comparison, download destinations and
/// deadlines, and the order "verify, then launch".
/// </summary>
/// <remarks>
/// Every network step runs against a stub <see cref="HttpMessageHandler"/> and the last
/// step against a captured launcher delegate, so no test downloads 49 MB or starts a real
/// Inno Setup program.
/// </remarks>
public sealed class UpdateInstallerTests : IDisposable
{
    /// <summary>SHA-256 of "dsh-mobile-update-payload".</summary>
    internal const string PayloadDigest = "4e41132fdceeb4cd303d0c21016be6b89fed393a9ef877ec593e64d7917e3fe1";

    /// <summary>SHA-256 of "hello".</summary>
    internal const string OtherDigest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    private static readonly byte[] Payload = Encoding.UTF8.GetBytes("dsh-mobile-update-payload");

    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "dsh-win-update-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // A leaked temp folder must not fail a test run.
        }
    }

    // ---- checksum sidecar ----

    [Theory]
    [InlineData(PayloadDigest + "  dsh-mobile-windows-v0.1.2-win-x64-setup.exe")]
    [InlineData(PayloadDigest)]
    [InlineData("  " + PayloadDigest + "\n")]
    [InlineData("*" + PayloadDigest + "  dsh-mobile-windows-v0.1.2-win-x64-setup.exe")]
    public void ParsesTheDigestFromASidecar(string sidecar)
    {
        Assert.Equal(PayloadDigest, UpdatePayload.ParseChecksum(sidecar));
    }

    [Fact]
    public void UppercaseSidecarIsNormalisedToLowercase()
    {
        Assert.Equal(PayloadDigest, UpdatePayload.ParseChecksum(PayloadDigest.ToUpperInvariant()));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("not a checksum")]
    [InlineData("0123456789abcdef")] // too short to be SHA-256
    [InlineData("zz41132fdceeb4cd303d0c21016be6b89fed393a9ef877ec593e64d7917e3fe1")]
    public void UnusableSidecarsYieldNoDigest(string? sidecar)
    {
        Assert.Null(UpdatePayload.ParseChecksum(sidecar));
    }

    [Fact]
    public void MatchingIsCaseInsensitiveButStrict()
    {
        Assert.True(UpdatePayload.Matches(PayloadDigest, PayloadDigest));
        Assert.True(UpdatePayload.Matches(PayloadDigest.ToUpperInvariant(), PayloadDigest));
        Assert.True(UpdatePayload.Matches(" " + PayloadDigest + " ", PayloadDigest));
        Assert.False(UpdatePayload.Matches(PayloadDigest, OtherDigest));
        Assert.False(UpdatePayload.Matches(PayloadDigest, string.Empty));
        Assert.False(UpdatePayload.Matches(null, PayloadDigest));
        Assert.False(UpdatePayload.Matches("nonsense", "nonsense"));
    }

    [Fact]
    public async Task HashesStreamsAndFilesToTheSameDigest()
    {
        await using var stream = new MemoryStream(Payload);
        Assert.Equal(PayloadDigest, await UpdatePayload.ComputeSha256Async(stream, CancellationToken.None));

        var path = Path.Combine(TempDir(), "payload.bin");
        await File.WriteAllBytesAsync(path, Payload);
        Assert.Equal(PayloadDigest, await UpdatePayload.ComputeFileSha256Async(path, CancellationToken.None));
    }

    // ---- verification ----

    [Fact]
    public async Task VerificationPassesForThePublishedDigest()
    {
        var path = Path.Combine(TempDir(), "setup.exe");
        await File.WriteAllBytesAsync(path, Payload);

        var failure = await UpdateInstaller.VerifyAsync(
            path, PayloadDigest + "  dsh-mobile-windows-v0.1.2-win-x64-setup.exe", CancellationToken.None);

        Assert.Null(failure);
    }

    [Fact]
    public async Task VerificationReportsBothDigestsOnMismatch()
    {
        var path = Path.Combine(TempDir(), "setup.exe");
        await File.WriteAllBytesAsync(path, Payload);

        var failure = await UpdateInstaller.VerifyAsync(path, OtherDigest, CancellationToken.None);

        Assert.NotNull(failure);
        Assert.False(failure!.Cancelled);
        Assert.Contains("校验失败", failure.Message);
        Assert.Contains(OtherDigest, failure.Message);
        Assert.Contains(PayloadDigest, failure.Message);
    }

    [Fact]
    public async Task VerificationNeverPassesWithoutAParsableDigest()
    {
        var path = Path.Combine(TempDir(), "setup.exe");
        await File.WriteAllBytesAsync(path, Payload);

        var failure = await UpdateInstaller.VerifyAsync(path, "sha256 of this file goes here", CancellationToken.None);

        Assert.NotNull(failure);
        Assert.Contains("没有可解析的 SHA-256", failure!.Message);
    }

    [Fact]
    public async Task UnreadableDownloadFailsVerificationInsteadOfThrowing()
    {
        var failure = await UpdateInstaller.VerifyAsync(
            Path.Combine(TempDir(), "missing.exe"), PayloadDigest, CancellationToken.None);

        Assert.NotNull(failure);
        Assert.Contains("无法读取", failure!.Message);
    }

    // ---- names, sizes, installer switches ----

    [Theory]
    [InlineData("dsh-mobile-windows-v0.1.2-win-x64-setup.exe", "dsh-mobile-windows-v0.1.2-win-x64-setup.exe")]
    [InlineData("../../evil.exe", "evil.exe")]
    [InlineData("..\\..\\evil.exe", "evil.exe")]
    [InlineData("C:\\Windows\\System32\\evil.exe", "evil.exe")]
    [InlineData("..", "fallback.bin")]
    [InlineData("", "fallback.bin")]
    [InlineData(null, "fallback.bin")]
    public void FileNamesCannotLeaveTheirDirectory(string? name, string expected)
    {
        Assert.Equal(expected, UpdatePayload.SafeFileName(name, "fallback.bin"));
    }

    [Theory]
    [InlineData(512, "512 B")]
    [InlineData(1536, "1.5 KB")]
    [InlineData(52428800, "50.0 MB")]
    [InlineData(1073741824, "1.00 GB")]
    public void DescribesTransferSizes(long bytes, string expected)
    {
        Assert.Equal(expected, UpdatePayload.DescribeSize(bytes));
    }

    [Fact]
    public void ProgressTextShowsBytesAndPercentForAKnownTotal()
    {
        var progress = new UpdateProgress(UpdateStage.Download, 5242880, 52428800);

        Assert.Equal(10, progress.Percent);
        Assert.Equal("5.0 MB / 50.0 MB（10%）", UpdatePayload.DescribeProgress(progress));
    }

    [Fact]
    public void ProgressTextFallsBackToBytesWhenTheSizeIsUnknown()
    {
        var progress = new UpdateProgress(UpdateStage.Download, 2048, null);

        Assert.Null(progress.Percent);
        Assert.Equal("已下载 2.0 KB", UpdatePayload.DescribeProgress(progress));
    }

    [Fact]
    public void ProgressTextNamesTheLaterStages()
    {
        Assert.Equal("正在校验 SHA-256…", UpdatePayload.DescribeProgress(new UpdateProgress(UpdateStage.Verify, 1, 1)));
        Assert.Equal("正在启动安装程序…", UpdatePayload.DescribeProgress(new UpdateProgress(UpdateStage.Launch, 1, 1)));
    }

    [Fact]
    public void InstallerRunsSilentlyAgainstTheDirectoryTheClientRunsFrom()
    {
        var arguments = UpdatePayload.SilentInstallArguments(@"C:\Users\dev\AppData\Local\Programs\DshMobile\");

        Assert.StartsWith("/SILENT ", arguments);
        Assert.Contains("/NORESTART ", arguments);
        Assert.Contains("/NORESTARTAPPLICATIONS", arguments);
        Assert.Contains("/DIR=\"C:\\Users\\dev\\AppData\\Local\\Programs\\DshMobile\"", arguments);
        // /VERYSILENT would hide Inno's progress window and /SUPPRESSMSGBOXES would hide a
        // real failure; both are deliberately absent.
        Assert.DoesNotContain("/VERYSILENT", arguments);
        Assert.DoesNotContain("/SUPPRESSMSGBOXES", arguments);
    }

    // ---- download ----

    [Fact]
    public async Task DownloadsTheBodyAndReportsProgress()
    {
        var progress = new RecordingProgress();
        var installer = Installer(new StubHandler((_, _) => Task.FromResult(Binary(Payload))));

        var outcome = await installer.DownloadAsync(
            new Uri("https://example.test/setup.exe"), TempDir(), "setup.exe", progress, CancellationToken.None);

        Assert.True(outcome.Ok);
        Assert.Equal(Payload.Length, outcome.File!.Bytes);
        Assert.Equal(Payload, await File.ReadAllBytesAsync(outcome.File.Path));
        Assert.False(File.Exists(outcome.File.Path + ".part"));
        var reports = progress.Reports;
        Assert.NotEmpty(reports);
        Assert.All(reports, report => Assert.Equal(UpdateStage.Download, report.Stage));
        Assert.Equal(Payload.Length, reports[^1].Received);
    }

    [Fact]
    public async Task InterruptedDownloadFailsAndLeavesNoPartialFile()
    {
        // The server promises more bytes than the body carries: a truncated transfer.
        var installer = Installer(new StubHandler((_, _) => Task.FromResult(Binary(Payload, declaredLength: Payload.Length + 1024))));
        var directory = TempDir();

        var outcome = await installer.DownloadAsync(
            new Uri("https://example.test/setup.exe"), directory, "setup.exe", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Contains("下载中断", outcome.Failure!.Message);
        Assert.Empty(Directory.GetFiles(directory));
    }

    [Fact]
    public async Task StalledTransferTimesOutInsteadOfHanging()
    {
        var installer = Installer(
            new StubHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(new StallingStream()),
            })),
            budget: new DownloadBudget(TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(150)));
        var directory = TempDir();

        var outcome = await installer.DownloadAsync(
            new Uri("https://example.test/setup.exe"), directory, "setup.exe", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.False(outcome.Failure!.Cancelled);
        Assert.Contains("超时", outcome.Failure.Message);
        Assert.Empty(Directory.GetFiles(directory));
    }

    [Fact]
    public async Task UserCancellationIsNotAnError()
    {
        var installer = Installer(new StubHandler(async (_, ct) =>
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
            return Binary(Payload);
        }));
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));

        var outcome = await installer.DownloadAsync(
            new Uri("https://example.test/setup.exe"), TempDir(), "setup.exe", null, cts.Token);

        Assert.False(outcome.Ok);
        Assert.True(outcome.Failure!.Cancelled);
        Assert.Contains("已取消", outcome.Failure.Message);
    }

    [Fact]
    public async Task MissingAssetReportsTheStatusCodeAndTheFallbackLink()
    {
        var installer = Installer(new StubHandler((_, _) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound))));

        var outcome = await installer.DownloadAsync(
            new Uri("https://example.test/setup.exe"), TempDir(), "setup.exe", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Contains("404", outcome.Failure!.Message);
        Assert.Contains(UpdateCheck.ReleasesPage, outcome.Failure.Message);
    }

    // ---- the whole pipeline ----

    [Fact]
    public async Task VerifiedInstallerIsHandedToTheLauncherWithSilentSwitches()
    {
        var launcher = new RecordingLauncher();
        var installer = Installer(HappyHandler(), launcher: launcher.Launch);

        var outcome = await installer.InstallAsync(Release(), @"C:\apps\DshMobile", null, CancellationToken.None);

        Assert.True(outcome.Ok);
        Assert.Single(launcher.Calls);
        var call = launcher.Calls[0];
        Assert.Equal(Path.Combine(_root, "v0.1.2", "dsh-mobile-windows-v0.1.2-win-x64-setup.exe"), call.Path);
        Assert.True(File.Exists(call.Path));
        Assert.Contains("/SILENT", call.Arguments);
        Assert.Contains("/DIR=\"C:\\apps\\DshMobile\"", call.Arguments);
    }

    [Fact]
    public async Task ChecksumMismatchDeletesTheDownloadAndNeverLaunches()
    {
        var launcher = new RecordingLauncher();
        var installer = Installer(HappyHandler(checksum: OtherDigest), launcher: launcher.Launch);

        var outcome = await installer.InstallAsync(Release(), @"C:\apps\DshMobile", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Contains("校验失败", outcome.Failure!.Message);
        Assert.Empty(launcher.Calls);
        Assert.Empty(Directory.GetFiles(Path.Combine(_root, "v0.1.2")));
    }

    [Fact]
    public async Task MissingChecksumAssetBlocksTheInstall()
    {
        var launcher = new RecordingLauncher();
        var installer = Installer(HappyHandler(), launcher: launcher.Launch);
        var release = Release(checksumUrl: null);

        var outcome = await installer.InstallAsync(release, @"C:\apps\DshMobile", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Contains("缺少 SHA-256 校验文件", outcome.Failure!.Message);
        Assert.Empty(launcher.Calls);
    }

    [Fact]
    public async Task ReleaseWithoutAnInstallerPointsAtTheDownloadPage()
    {
        var launcher = new RecordingLauncher();
        var installer = Installer(new StubHandler((_, _) => throw new InvalidOperationException("no request expected")),
            launcher: launcher.Launch);

        var outcome = await installer.InstallAsync(
            Release(setupUrl: null), @"C:\apps\DshMobile", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Contains("没有提供安装包", outcome.Failure!.Message);
        Assert.Contains(UpdateCheck.ReleasesPage, outcome.Failure.Message);
        Assert.Empty(launcher.Calls);
    }

    [Fact]
    public async Task UnlaunchableInstallerKeepsTheVerifiedPackageForAManualRun()
    {
        var installer = Installer(HappyHandler(), launcher: (_, _) => throw new InvalidOperationException("blocked by antivirus"));

        var outcome = await installer.InstallAsync(Release(), @"C:\apps\DshMobile", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Contains("无法启动安装程序", outcome.Failure!.Message);
        Assert.Contains("blocked by antivirus", outcome.Failure.Detail!);
        // The verified installer is kept on purpose: the message tells the user to run it.
        var files = Directory.GetFiles(Path.Combine(_root, "v0.1.2"));
        Assert.Single(files);
        Assert.Contains(files[0], outcome.Failure.Message);
    }

    [Fact]
    public async Task ABadChecksumBodyStillBlocksTheInstall()
    {
        var launcher = new RecordingLauncher();
        var installer = Installer(
            new StubHandler((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath.EndsWith(".sha256")
                ? Text("<html>rate limited</html>")
                : Binary(Payload))),
            launcher: launcher.Launch);

        var outcome = await installer.InstallAsync(Release(), @"C:\apps\DshMobile", null, CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Contains("校验失败", outcome.Failure!.Message);
        Assert.Empty(launcher.Calls);
    }

    [Fact]
    public async Task StaleFilesInTheTempFolderAreNotReused()
    {
        var directory = Path.Combine(_root, "v0.1.2");
        Directory.CreateDirectory(directory);
        var stale = Path.Combine(directory, "dsh-mobile-windows-v0.1.2-win-x64-setup.exe");
        await File.WriteAllBytesAsync(stale, Encoding.UTF8.GetBytes("old download"));

        var launcher = new RecordingLauncher();
        var installer = Installer(HappyHandler(), launcher: launcher.Launch);
        var outcome = await installer.InstallAsync(Release(), @"C:\apps\DshMobile", null, CancellationToken.None);

        Assert.True(outcome.Ok);
        Assert.Single(launcher.Calls);
        Assert.Equal(Payload, await File.ReadAllBytesAsync(stale));
    }

    // ---- helpers ----

    private string TempDir()
    {
        Directory.CreateDirectory(_root);
        return _root;
    }

    private UpdateInstaller Installer(
        HttpMessageHandler handler,
        InstallerLauncher? launcher = null,
        DownloadBudget? budget = null) =>
        new(new HttpClient(handler), launcher, budget, _root);

    private static WindowsRelease Release(string? setupUrl = "https://example.test/dsh-mobile-windows-v0.1.2-win-x64-setup.exe",
        string? checksumUrl = "https://example.test/dsh-mobile-windows-v0.1.2-win-x64-setup.exe.sha256") =>
        new("windows-v0.1.2", "0.1.2", "https://example.test/page", false, setupUrl, checksumUrl);

    private static StubHandler HappyHandler(string checksum = PayloadDigest) => new((request, _) =>
        Task.FromResult(request.RequestUri!.AbsolutePath.EndsWith(".sha256")
            ? Text(checksum + "  dsh-mobile-windows-v0.1.2-win-x64-setup.exe")
            : Binary(Payload)));

    private static HttpResponseMessage Binary(byte[] body, long? declaredLength = null)
    {
        var content = new ByteArrayContent(body);
        if (declaredLength is { } length) content.Headers.ContentLength = length;
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
    }

    private static HttpResponseMessage Text(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8) };

    private sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) => respond(request, cancellationToken);
    }

    /// <summary>A stream that never produces a byte, to prove the stall deadline fires.</summary>
    private sealed class StallingStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
    }

    private sealed class RecordingProgress : IProgress<UpdateProgress>
    {
        private readonly object _lock = new();
        private readonly List<UpdateProgress> _reports = [];

        internal IReadOnlyList<UpdateProgress> Reports
        {
            get { lock (_lock) return [.. _reports]; }
        }

        public void Report(UpdateProgress value)
        {
            lock (_lock) _reports.Add(value);
        }
    }

    private sealed class RecordingLauncher
    {
        internal List<(string Path, string Arguments)> Calls { get; } = [];

        internal void Launch(string executablePath, string arguments) =>
            Calls.Add((executablePath, arguments));
    }
}
