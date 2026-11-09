using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace DshMobile.Win;

/// <summary>
/// Runs the pinned dsh-mobile-iroh-host-win32-x64.exe "phone-sim" subcommand as the
/// Windows client transport. It is already an authenticated iroh Endpoint + Pair/Hello
/// handshake + loopback byte proxy (presets::N0, ALPN dsh-mobile-iroh/0), so no Rust
/// build is needed. The local listener carries raw TLS bytes; TLS still ends at the
/// remote Gateway. All state lives in an explicitly supplied data directory.
/// </summary>
internal sealed class IrohCarrier : IDisposable
{
    private readonly string _exePath;
    private Process? _process;
    private readonly TaskCompletionSource<string> _ready =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly StringBuilder _diagnostics = new();
    private readonly object _diagnosticsLock = new();

    /// <summary>Last stderr lines, used to translate sidecar failures into actionable hints.</summary>
    internal string Diagnostics { get { lock (_diagnosticsLock) return _diagnostics.ToString(); } }

    internal event Action<string>? Log;
    internal event Action<string>? Failed;

    internal string? ProxyOrigin { get; private set; }

    internal IrohCarrier(string exePath)
    {
        if (!File.Exists(exePath)) throw new FileNotFoundException("iroh sidecar not found", exePath);
        _exePath = exePath;
    }

    /// <summary>
    /// With a pairingCode the sidecar sends Wire::Pair (first-time pairing). Without it
    /// the sidecar sends Wire::Hello, which the Host accepts for an already-paired
    /// device without any pairing window. Both paths use presets::N0 discovery + relay.
    /// </summary>
    internal async Task StartAsync(SavedDevice device, string? pairingCode, string dataDir, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _exePath,
            WorkingDirectory = Path.GetDirectoryName(_exePath)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        var args = new List<string>
        {
            "phone-sim",
            "--data-dir", dataDir,
            "--peer", device.EndpointId,
            "--name", "DeepSeek Harness Windows",
            "--proxy-listen", $"127.0.0.1:{device.LocalPort}",
        };
        if (!string.IsNullOrEmpty(pairingCode))
        {
            args.Add("--code");
            args.Add(pairingCode);
        }
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        var process = Process.Start(psi) ?? throw new InvalidOperationException("failed to start iroh sidecar");
        _process = process;
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) =>
        {
            var reason = $"iroh sidecar exited (code {process.ExitCode})";
            _ready.TrySetException(new IOException(reason));
            Failed?.Invoke(reason);
        };
        _ = Task.Run(() => PumpStdout(process), CancellationToken.None);
        _ = Task.Run(() => PumpStderr(process), CancellationToken.None);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(45));
        var expired = Task.Delay(Timeout.InfiniteTimeSpan, timeout.Token);
        var finished = await Task.WhenAny(_ready.Task, expired).ConfigureAwait(false);
        if (finished != _ready.Task)
            throw new TimeoutException("iroh connection did not become ready within 45s");
        ProxyOrigin = await _ready.Task.ConfigureAwait(false);
    }

    private async Task PumpStdout(Process process)
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                Log?.Invoke("iroh: " + line);
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("version", out var version) && version.GetInt32() != 1) continue;
                if (!root.TryGetProperty("type", out var type) || type.GetString() != "proxy-ready") continue;
                if (root.TryGetProperty("origin", out var origin) && origin.GetString() is { } value)
                    _ready.TrySetResult(value);
            }
        }
        catch (Exception error) { _ready.TrySetException(error); }
    }

    private async Task PumpStderr(Process process)
    {
        try
        {
            while (await process.StandardError.ReadLineAsync() is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                lock (_diagnosticsLock)
                {
                    if (_diagnostics.Length < 4000) _diagnostics.AppendLine(line);
                }
                Log?.Invoke("iroh: " + line);
            }
        }
        catch { /* process exited */ }
    }

    public void Dispose()
    {
        var process = _process;
        _process = null;
        if (process is null) return;
        try
        {
            if (!process.HasExited)
            {
                // phone-sim has no stdin shutdown command; Ctrl+C is unavailable on Windows
                // child processes. Killing is terminal and closes every proxy child.
                process.Kill(entireProcessTree: true);
                process.WaitForExit(3000);
            }
        }
        catch { /* already gone */ }
        finally { process.Dispose(); }
    }
}
