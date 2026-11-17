using System.IO;
using System.Text;

namespace DshMobile.Win;

/// <summary>
/// One SSE event: the plugin sends `event: task-notify` with a JSON body
/// {sessionId, turn, title?, body?}, plus `event: device-revoked`.
/// Heartbeats (`: heartbeat`), `retry:` and unknown events are ignored.
/// </summary>
internal sealed record SseNotification(string Event, string Data);

/// <summary>Incremental SSE frame parser: blank line dispatches one event.</summary>
internal sealed class SseParser
{
    private string? _event;
    private readonly StringBuilder _data = new();
    private bool _hasData;

    internal SseNotification? FeedLine(string line)
    {
        if (line.Length == 0)
        {
            var notification = Dispatch();
            Reset();
            return notification;
        }
        if (line.StartsWith(':')) return null; // comment / heartbeat
        var colon = line.IndexOf(':');
        if (colon < 0) return null;
        var field = line[..colon].Trim();
        var value = line[(colon + 1)..].TrimStart();
        if (field == "event") _event = value;
        else if (field == "data")
        {
            if (_hasData) _data.Append('\n');
            _data.Append(value);
            _hasData = true;
        }
        return null;
    }

    private SseNotification? Dispatch()
    {
        if (!_hasData || string.IsNullOrEmpty(_event)) return null;
        return new SseNotification(_event, _data.ToString());
    }

    private void Reset()
    {
        _event = null;
        _data.Clear();
        _hasData = false;
    }
}

/// <summary>
/// Subscribes to GET /mobile-access/background-events while a computer is
/// connected and surfaces task completions as desktop notifications, the
/// same stream the Android dataSync service consumes. Revocation stops the
/// watcher permanently; transport failures back off and retry, renewing the
/// session once on an auth rejection before giving up.
/// </summary>
internal sealed class BackgroundEventWatcher : IDisposable
{
    internal event Action<string?, string?>? TaskNotified;
    internal event Action<string>? Revoked;

    private readonly SavedDevice _device;
    private readonly Func<CancellationToken, Task<NativeSession>> _renewAsync;
    private readonly Action<string> _log;
    private CancellationTokenSource? _cts;
    private Task? _loop;

    internal BackgroundEventWatcher(
        SavedDevice device,
        Func<CancellationToken, Task<NativeSession>> renewAsync,
        Action<string> log)
    {
        _device = device;
        _renewAsync = renewAsync;
        _log = log;
    }

    internal void Start(string sessionToken)
    {
        if (_cts is not null) return;
        _cts = new CancellationTokenSource();
        _loop = RunAsync(sessionToken, _cts.Token);
    }

    internal void Stop()
    {
        try { _cts?.Cancel(); } catch { /* already stopping */ }
        _cts = null;
        _loop = null;
    }

    public void Dispose() => Stop();

    private async Task RunAsync(string sessionToken, CancellationToken ct)
    {
        var token = sessionToken;
        var backoff = TimeSpan.FromSeconds(5);
        var renewed = false;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var ssl = await GatewayAuth.OpenEventStreamAsync(_device, token, ct);
                backoff = TimeSpan.FromSeconds(5);
                renewed = false;
                _log("background event stream opened");
                using var reader = new StreamReader(ssl, Encoding.UTF8);
                var parser = new SseParser();
                while (!ct.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(ct);
                    if (line is null) break; // server closed the stream
                    var notification = parser.FeedLine(line);
                    if (notification is not null) Dispatch(notification);
                }
                _log("background event stream closed by the server");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                if (IsTerminalRejection(error))
                {
                    _log("background events rejected permanently: " + error.Message);
                    Revoked?.Invoke(error.Message);
                    return;
                }
                if (!renewed && IsAuthRejection(error))
                {
                    renewed = true;
                    try
                    {
                        var session = await _renewAsync(ct);
                        token = session.SessionToken;
                        _log("background events session renewed");
                        continue;
                    }
                    catch (Exception renewError)
                    {
                        _log("background events renew failed: " + renewError.Message);
                        Revoked?.Invoke(renewError.Message);
                        return;
                    }
                }
                _log($"background events error, retrying in {backoff.TotalSeconds:n0}s: {error.Message}");
                try { await Task.Delay(backoff, ct); } catch { return; }
                if (backoff < TimeSpan.FromSeconds(30)) backoff *= 2;
            }
        }
    }

    private void Dispatch(SseNotification notification)
    {
        if (notification.Event == "device-revoked")
        {
            _log("device revoked by the computer");
            Revoked?.Invoke("电脑端已撤销此设备");
            return;
        }
        if (notification.Event != "task-notify") return;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(notification.Data);
            var root = doc.RootElement;
            string? title = root.TryGetProperty("title", out var t) ? t.GetString() : null;
            string? body = root.TryGetProperty("body", out var b) ? b.GetString() : null;
            _log($"task-notify turn received (title={(title is null ? "no" : "yes")})");
            TaskNotified?.Invoke(title, body);
        }
        catch (Exception error)
        {
            _log("ignoring malformed task-notify: " + error.Message);
        }
    }

    private static bool IsTerminalRejection(Exception error) =>
        error.Message.Contains("device_revoked", StringComparison.Ordinal) ||
        error.Message.Contains("device_expired", StringComparison.Ordinal) ||
        error.Message.Contains("device credential", StringComparison.OrdinalIgnoreCase) ||
        error.Message.Contains("设备凭据", StringComparison.Ordinal);

    private static bool IsAuthRejection(Exception error) =>
        error.Message.Contains("401", StringComparison.Ordinal) ||
        error.Message.Contains("authentication_failed", StringComparison.Ordinal) ||
        error.Message.Contains("403", StringComparison.Ordinal);
}
