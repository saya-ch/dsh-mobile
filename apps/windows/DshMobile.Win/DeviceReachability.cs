using System.Net.Sockets;
using System.Security.Authentication;

namespace DshMobile.Win;

/// <summary>One completed reachability observation for one saved computer.</summary>
/// <param name="EndpointId">The record this result belongs to.</param>
/// <param name="Kind">What the probe concluded.</param>
/// <param name="ObservedAt">Unix milliseconds when the probe finished.</param>
internal sealed record ReachabilityObservation(string EndpointId, DeviceStatusKind Kind, long ObservedAt);

/// <summary>
/// Background reachability polling for the paired-computer list, mirroring Android's
/// DeviceStatusPoller: at most two probes in flight, at most one probe per computer per
/// interval, no probe while a connection is starting, and results delivered to the UI
/// through an event instead of touching controls from a worker thread.
/// </summary>
/// <remarks>
/// Probing reuses <see cref="LanDiscovery.ProbeAsync"/>, the same unauthenticated
/// <c>GET /mobile-access/discovery</c> call the LAN scanner uses. That is deliberate:
/// it needs no device credential, so polling never mints a session or races a real
/// connect for the renewal token, and its payload carries the gateway's instance id,
/// which is what distinguishes "this computer answered" from "some gateway answered at
/// this address". A computer that has revoked this device still answers discovery, so
/// polling can report reachability but never revocation; revocation stays what it was,
/// a fact learned when a connection is actually attempted.
///
/// iroh rows are skipped. Their gateway is only reachable through the sidecar's
/// loopback proxy, which does not exist until a connect starts, so probing them would
/// report "unreachable" for every healthy iroh pairing.
/// </remarks>
internal sealed class DeviceReachability : IDisposable
{
    /// <summary>Minimum gap between two probes of the same computer.</summary>
    internal static readonly TimeSpan ProbeInterval = TimeSpan.FromSeconds(15);

    /// <summary>How often the scheduler looks for due work.</summary>
    internal static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(3);

    /// <summary>Hard cap per probe, below the discovery call's own 10s deadline.</summary>
    internal static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(8);

    /// <summary>At most two probes at once, leaving room for an explicit connection.</summary>
    internal const int MaxConcurrent = 2;

    private readonly Func<SavedDevice, CancellationToken, Task<DeviceStatusKind>> _probe;
    private readonly Action<ReachabilityObservation> _onResult;
    private readonly Action<string> _log;
    private readonly Func<bool> _isPaused;
    private readonly object _gate = new();

    private readonly Dictionary<string, long> _lastProbeAt = new(StringComparer.Ordinal);
    private readonly HashSet<string> _inFlight = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DeviceStatusKind> _results = new(StringComparer.Ordinal);
    private readonly HashSet<string> _revoked = new(StringComparer.Ordinal);

    private IReadOnlyList<SavedDevice> _devices = [];
    private CancellationTokenSource? _loopCts;
    private Task? _loop;
    private long _epoch;
    private bool _disposed;

    /// <param name="probe">Performs one probe; returns the state it observed.</param>
    /// <param name="onResult">Receives results; called from a worker thread.</param>
    /// <param name="log">Diagnostics sink.</param>
    /// <param name="isPaused">
    /// True while a connection is being established, so polling cannot compete with it
    /// for the network or race the credential it is renewing.
    /// </param>
    internal DeviceReachability(
        Func<SavedDevice, CancellationToken, Task<DeviceStatusKind>> probe,
        Action<ReachabilityObservation> onResult,
        Action<string> log,
        Func<bool> isPaused)
    {
        _probe = probe;
        _onResult = onResult;
        _log = log;
        _isPaused = isPaused;
    }

    /// <summary>Last observed state for one record, or null when it has not been probed.</summary>
    internal DeviceStatusKind? ResultFor(string endpointId)
    {
        lock (_gate) return _results.TryGetValue(endpointId, out var kind) ? kind : null;
    }

    /// <summary>
    /// Mark a record as revoked by the computer. Sticky: a discovery probe cannot see a
    /// revocation, so it must never clear this. Called when a connection attempt reports
    /// that the computer rejected the stored credential.
    /// </summary>
    internal void MarkRevoked(string endpointId)
    {
        lock (_gate)
        {
            _revoked.Add(endpointId);
            _results[endpointId] = DeviceStatusKind.Revoked;
        }
        _onResult(new ReachabilityObservation(endpointId, DeviceStatusKind.Revoked,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
    }

    /// <summary>Forget a record entirely (after delete, or a re-pair replaced it).</summary>
    internal void Forget(string endpointId)
    {
        lock (_gate)
        {
            _results.Remove(endpointId);
            _lastProbeAt.Remove(endpointId);
            _revoked.Remove(endpointId);
        }
    }

    /// <summary>
    /// Replace the set of records to poll and start the loop if it is not running.
    /// Already-probed records keep their result; new ones become due immediately.
    /// </summary>
    internal void Refresh(IReadOnlyList<SavedDevice> devices)
    {
        lock (_gate)
        {
            if (_disposed) return;
            _devices = devices;
            // Drop state for records that no longer exist, so a deleted computer cannot
            // leave a stale result behind for a future record with the same key.
            var live = devices.Select(d => d.EndpointId).ToHashSet(StringComparer.Ordinal);
            foreach (var key in _results.Keys.Where(k => !live.Contains(k)).ToList()) _results.Remove(key);
            foreach (var key in _lastProbeAt.Keys.Where(k => !live.Contains(k)).ToList()) _lastProbeAt.Remove(key);
            foreach (var key in _revoked.Where(k => !live.Contains(k)).ToList()) _revoked.Remove(key);
        }
        EnsureLoop();
    }

    /// <summary>Stop polling and reject any result still in flight.</summary>
    internal void Stop()
    {
        CancellationTokenSource? cts;
        Task? loop;
        lock (_gate)
        {
            cts = _loopCts;
            loop = _loop;
            _loopCts = null;
            _loop = null;
            _epoch++; // results already running no longer own a slot in the new epoch
        }
        try { cts?.Cancel(); } catch { /* already gone */ }
        cts?.Dispose();
        _ = loop; // the loop observes cancellation itself; nothing to await here
    }

    private void EnsureLoop()
    {
        lock (_gate)
        {
            if (_disposed || _loop is not null) return;
            _loopCts = new CancellationTokenSource();
            var token = _loopCts.Token;
            _loop = Task.Run(() => LoopAsync(token));
        }
    }

    private async Task LoopAsync(CancellationToken token)
    {
        try
        {
            using var timer = new PeriodicTimer(TickInterval);
            do
            {
                await PumpAsync(token).ConfigureAwait(false);
            }
            while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false));
        }
        catch (OperationCanceledException) { /* stopped */ }
        catch (Exception error) { _log("reachability loop stopped: " + error.Message); }
    }

    private async Task PumpAsync(CancellationToken token)
    {
        // A connection in progress owns the network and the credential; wait it out.
        if (_isPaused()) return;

        List<SavedDevice> due;
        long epoch;
        lock (_gate)
        {
            if (_disposed) return;
            epoch = _epoch;
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            due = SelectDue(_devices, _lastProbeAt, now, _inFlight, _revoked);
            foreach (var device in due)
            {
                _inFlight.Add(device.EndpointId);
                _lastProbeAt[device.EndpointId] = now;
            }
        }
        if (due.Count == 0) return;

        await Task.WhenAll(due.Select(device => ProbeOneAsync(device, epoch, token)))
            .ConfigureAwait(false);
    }

    private async Task ProbeOneAsync(SavedDevice device, long epoch, CancellationToken token)
    {
        DeviceStatusKind kind;
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(ProbeTimeout);
            kind = await _probe(device, deadline.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Cancellation is not an observation: leaving the state as it was avoids
            // painting a healthy computer as unreachable because the window closed. But the
            // deadline we created above uses the same exception type — a probe that timed out
            // against a black-holed host must be recorded as unreachable, not silently kept
            // as "checking" or, worse, as the last known "reachable".
            //
            // Only the cancelled case clears the in-flight marker here. The timeout case
            // falls through to the common path, which removes it once; removing it twice
            // would let a probe that started in between lose its marker.
            if (token.IsCancellationRequested)
            {
                lock (_gate) _inFlight.Remove(device.EndpointId);
                return;
            }
            _log($"reachability probe timed out for {device.ShortId}");
            kind = DeviceStatusKind.Unreachable;
        }
        catch (Exception error)
        {
            _log($"reachability probe failed for {device.ShortId}: {error.GetType().Name}");
            kind = DeviceStatusKind.Unreachable;
        }

        bool owned;
        lock (_gate)
        {
            _inFlight.Remove(device.EndpointId);
            // A late result after Stop/Refresh belongs to an older epoch and must not
            // overwrite a newer one (the same guard the phone's poller applies).
            owned = !_disposed && epoch == _epoch;
            if (owned)
            {
                if (_revoked.Contains(device.EndpointId)) return;
                _results[device.EndpointId] = kind;
            }
        }
        if (owned)
            _onResult(new ReachabilityObservation(device.EndpointId, kind,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
    }

    /// <summary>
    /// Which records may be probed right now: never a revoked one, never one already in
    /// flight, never one probed inside <see cref="ProbeInterval"/>, and no more than the
    /// free concurrency slots. iroh rows are excluded.
    /// </summary>
    internal static List<SavedDevice> SelectDue(
        IReadOnlyList<SavedDevice> devices,
        IReadOnlyDictionary<string, long> lastProbeAt,
        long now,
        IReadOnlySet<string> inFlight,
        IReadOnlySet<string> revoked)
    {
        var interval = (long)ProbeInterval.TotalMilliseconds;
        var slots = MaxConcurrent - inFlight.Count;
        var due = new List<SavedDevice>();
        if (slots <= 0) return due;
        foreach (var device in devices)
        {
            if (due.Count >= slots) break;
            if (device.Channel == "iroh") continue;
            if (revoked.Contains(device.EndpointId)) continue;
            if (inFlight.Contains(device.EndpointId)) continue;
            if (lastProbeAt.TryGetValue(device.EndpointId, out var last) && now - last < interval) continue;
            due.Add(device);
        }
        return due;
    }

    /// <summary>
    /// Probe one computer now, on the caller's behalf ("立即检测"). Bypasses the
    /// interval but refuses to run while a connection is starting, and still respects
    /// the concurrency cap so repeated clicks cannot open a dozen sockets.
    /// </summary>
    internal void CheckNow(SavedDevice device, Action<string> log)
    {
        if (device.Channel == "iroh")
        {
            log("reachability: iroh rows can only be checked by connecting");
            return;
        }
        long epoch;
        lock (_gate)
        {
            if (_disposed) return;
            if (_revoked.Contains(device.EndpointId)) return;
            if (_inFlight.Contains(device.EndpointId)) return;
            if (_inFlight.Count >= MaxConcurrent)
            {
                log("reachability: all probe slots busy");
                return;
            }
            _lastProbeAt[device.EndpointId] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _inFlight.Add(device.EndpointId);
            epoch = _epoch;
        }
        _ = Task.Run(() => ProbeOneAsync(device, epoch, CancellationToken.None));
    }

    /// <summary>
    /// The default probe: the unauthenticated discovery call, classified against the
    /// record. An instance-id mismatch means some other gateway took this address over
    /// (a rotated tunnel, a reassigned LAN IP), which is exactly the phone's
    /// "address may have changed" state.
    /// </summary>
    internal static async Task<DeviceStatusKind> ProbeAsync(SavedDevice device, CancellationToken token)
    {
        try
        {
            var gateway = await LanDiscovery.ProbeAsync(device.Hostname, device.LocalPort, token)
                .ConfigureAwait(false);
            return gateway.InstanceId == device.InstanceId
                ? DeviceStatusKind.Reachable
                : DeviceStatusKind.AddressChanged;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (SocketException)
        {
            return DeviceStatusKind.Unreachable;
        }
        catch (AuthenticationException)
        {
            // The host answered TCP but refused a TLS handshake: something is listening
            // and it is not this gateway. Reporting "unreachable" would invite a retry
            // against the wrong device, so treat it as a changed address.
            return DeviceStatusKind.AddressChanged;
        }
        catch (Exception)
        {
            // DNS failure, refused connection, non-200 or a malformed discovery payload.
            return DeviceStatusKind.Unreachable;
        }
    }

    public void Dispose()
    {
        lock (_gate) _disposed = true;
        Stop();
    }
}
