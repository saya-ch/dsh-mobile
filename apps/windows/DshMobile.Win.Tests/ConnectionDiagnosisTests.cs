using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// Connection failure classification. The categories mirror Android's LoadFailure
/// mapping (SecureWebViewClient.kt) plus the desktop-only cases, so the two products
/// explain the same failure the same way.
/// </summary>
public class ConnectionDiagnosisTests
{
    private static ConnectionTarget Direct(string channel = "remote", string host = "example.cpolar.cn") =>
        new(channel, host);

    private static ConnectionTarget Iroh() => new("iroh", "abc.iroh.localhost");

    // ---- HTTP status mapping (mirrors loadFailureForHttpStatus) ----

    [Theory]
    [InlineData(401, (int)ConnectionFailureKind.CredentialExpired)]
    [InlineData(403, (int)ConnectionFailureKind.CredentialExpired)]
    [InlineData(426, (int)ConnectionFailureKind.ProtocolMismatch)]
    [InlineData(429, (int)ConnectionFailureKind.RateLimited)]
    [InlineData(500, (int)ConnectionFailureKind.ServiceUnavailable)]
    [InlineData(503, (int)ConnectionFailureKind.ServiceUnavailable)]
    [InlineData(599, (int)ConnectionFailureKind.ServiceUnavailable)]
    [InlineData(404, (int)ConnectionFailureKind.Network)]
    public void ClassifyHttpStatusMatchesAndroid(int status, int expected)
    {
        Assert.Equal((ConnectionFailureKind)expected, ConnectionDiagnosis.ClassifyHttpStatus(status));
    }

    [Theory]
    [InlineData("Gateway rejected auth: HTTP/1.1 429 Too Many Requests {}", 429)]
    [InlineData("Gateway rejected auth: HTTP/1.1 503 Service Unavailable", 503)]
    [InlineData("HTTP/1.1 200 OK", 200)]
    public void ExtractsStatusFromGatewayRejection(string message, int expected)
    {
        Assert.True(ConnectionDiagnosis.TryExtractHttpStatus(message, out var status));
        Assert.Equal(expected, status);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("no status here")]
    [InlineData("HTTP/1.1 ")]
    [InlineData("HTTP/1.1 12")]      // too few digits
    [InlineData("HTTP/1.1 9999")]    // out of range
    public void RejectsMessagesWithoutAStatus(string? message)
    {
        Assert.False(ConnectionDiagnosis.TryExtractHttpStatus(message, out _));
    }

    // ---- cpolar address staleness ----

    [Theory]
    [InlineData("abc.cpolar.cn")]
    [InlineData("abc.cpolar.io")]
    [InlineData("abc.cpolar.top")]
    [InlineData("abc.cpolar.com")]
    [InlineData("ABC.CPOLAR.CN")]     // case-insensitive
    [InlineData("abc.cpolar.cn.")]    // trailing dot
    public void RecognisesCpolarHosts(string host)
    {
        Assert.True(ConnectionDiagnosis.IsCpolarHost(host));
    }

    [Theory]
    [InlineData("example.trycloudflare.com")]
    [InlineData("192.168.1.18")]
    [InlineData("gateway.local")]
    [InlineData("notcpolar.cn")]
    [InlineData("")]
    [InlineData(null)]
    public void RejectsNonCpolarHosts(string? host)
    {
        Assert.False(ConnectionDiagnosis.IsCpolarHost(host));
    }

    // ---- the specific categories ----

    [Fact]
    public void RevokedDeviceCredentialAsksToRepair()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("Gateway rejected auth: HTTP/1.1 401 Unauthorized {}"),
            null, Direct());
        Assert.Equal(ConnectionFailureKind.CredentialExpired, failure.Kind);
        Assert.True(failure.Repair);
        Assert.Contains("凭据", failure.Hint);
    }

    [Theory]
    [InlineData("device_expired")]
    [InlineData("device_revoked")]
    [InlineData("设备凭据不可用")]
    public void CredentialCodesAreRecognised(string message)
    {
        var failure = ConnectionDiagnosis.Diagnose(new InvalidOperationException(message), null, Direct());
        Assert.Equal(ConnectionFailureKind.CredentialExpired, failure.Kind);
    }

    [Fact]
    public void SidecarPairingRejectionIsACredentialFailure()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new IOException("iroh sidecar exited (code 1)"),
            "the host did not acknowledge the hello", Iroh());
        Assert.Equal(ConnectionFailureKind.CredentialExpired, failure.Kind);
    }

    [Theory]
    [InlineData("unsupported_protocol")]
    [InlineData("version_mismatch")]
    [InlineData("client too old")]
    [InlineData("协议不兼容")]
    [InlineData("版本不兼容")]
    public void VersionMismatchIsItsOwnCategory(string message)
    {
        var failure = ConnectionDiagnosis.Diagnose(new InvalidOperationException(message), null, Iroh());
        Assert.Equal(ConnectionFailureKind.ProtocolMismatch, failure.Kind);
        Assert.Contains("更新", failure.Hint);
    }

    [Fact]
    public void Http426IsAVersionMismatch()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("Gateway rejected auth: HTTP/1.1 426 Upgrade Required"),
            null, Direct("lan", "192.168.1.18"));
        Assert.Equal(ConnectionFailureKind.ProtocolMismatch, failure.Kind);
    }

    [Fact]
    public void PinnedCaMismatchIsNeverReportedAsGenericTls()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("配对 CA 校验失败：这台电脑出示的证书与配对时固定的不一致"),
            null, Direct());
        Assert.Equal(ConnectionFailureKind.CaMismatch, failure.Kind);
        Assert.False(failure.Repair);
        Assert.DoesNotContain("TLS", failure.Hint);
    }

    [Fact]
    public void TlsFailureIsItsOwnCategory()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new System.Security.Authentication.AuthenticationException("The SSL connection could not be established"),
            null, Direct("lan", "192.168.1.18"));
        Assert.Equal(ConnectionFailureKind.Tls, failure.Kind);
        Assert.Contains("TLS", failure.Hint);
    }

    [Fact]
    public void UnresolvableLanHostExplainsTheLocalNetwork()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("无法解析主机 gateway.local"), null, Direct("lan", "gateway.local"));
        Assert.Equal(ConnectionFailureKind.HostUnresolved, failure.Kind);
        Assert.Contains("同一网络", failure.Hint);
        Assert.True(failure.Repair);
    }

    [Fact]
    public void UnresolvableRemoteHostExplainsTheTunnel()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("无法解析主机 abc.trycloudflare.com"), null,
            Direct("remote", "abc.trycloudflare.com"));
        Assert.Equal(ConnectionFailureKind.HostUnresolved, failure.Kind);
        Assert.Contains("远程通道", failure.Hint);
    }

    [Fact]
    public void SocketFailureOnACpolarHostBlamesTheRotatedAddress()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new System.Net.Sockets.SocketException((int)System.Net.Sockets.SocketError.HostNotFound),
            null, Direct("remote", "abc.cpolar.cn"));
        Assert.Equal(ConnectionFailureKind.CpolarAddressStale, failure.Kind);
        Assert.True(failure.Repair);
        Assert.Contains("cpolar", failure.Hint);
        Assert.Contains("新的配对链接", failure.Hint);
    }

    [Theory]
    [InlineData("No such host is known")]          // English Windows
    [InlineData("不知道这样的主机")]                  // Chinese Windows
    [InlineData("nodename nor servname provided")] // macOS
    public void HostResolutionFailureIsRecognisedWhateverLanguageTheOsReportsItIn(string osMessage)
    {
        // The classification used to read the exception message, which is localised,
        // so the same failure was "host unresolved" on an English machine and
        // "network" elsewhere. The socket error code is language-independent and must
        // drive the decision; the message stays only as a fallback.
        var error = new System.Net.Sockets.SocketException(
            (int)System.Net.Sockets.SocketError.HostNotFound) { };
        Assert.True(ConnectionDiagnosis.IsHostUnresolved(error, osMessage));
    }

    [Fact]
    public void HostResolutionFailureIsRecognisedFromTheSocketCodeAlone()
    {
        // A SocketException carries HostNotFound even when the message is something
        // this build has never seen, which is the case on any OS locale we did not
        // anticipate.
        var error = new System.Net.Sockets.SocketException(
            (int)System.Net.Sockets.SocketError.HostNotFound);
        Assert.True(ConnectionDiagnosis.IsHostUnresolved(error, null));
        Assert.True(ConnectionDiagnosis.IsHostUnresolved(error, "some localised text"));
    }

    [Fact]
    public void SocketFailureOnANonCpolarRemoteHostIsPlainNetwork()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new System.Net.Sockets.SocketException((int)System.Net.Sockets.SocketError.ConnectionRefused),
            null, Direct("remote", "myhost.tailscale.net"));
        Assert.Equal(ConnectionFailureKind.Network, failure.Kind);
        Assert.True(failure.Repair);
    }

    [Fact]
    public void Http429ExplainsRateLimiting()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("Gateway rejected auth: HTTP/1.1 429 Too Many Requests"),
            null, Direct("lan", "192.168.1.18"));
        Assert.Equal(ConnectionFailureKind.RateLimited, failure.Kind);
        Assert.Contains("429", failure.Hint);
    }

    [Fact]
    public void Http503ExplainsServiceUnavailable()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("Gateway rejected auth: HTTP/1.1 503 Service Unavailable"),
            null, Direct("lan", "192.168.1.18"));
        Assert.Equal(ConnectionFailureKind.ServiceUnavailable, failure.Kind);
        Assert.Contains("503", failure.Hint);
    }

    [Fact]
    public void MissingWebView2PointsAtTheDownloadPage()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("WebView2 runtime is not installed"), null, Iroh());
        Assert.Equal(ConnectionFailureKind.WebView2Unavailable, failure.Kind);
        Assert.Contains(WebView2Availability.DownloadUrl, failure.Hint);
    }

    [Fact]
    public void TimeoutIsReportedAsTimeout()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new TimeoutException("iroh connection did not become ready within 45s"), null, Iroh());
        Assert.Equal(ConnectionFailureKind.Timeout, failure.Kind);
    }

    [Fact]
    public void IrohDiscoveryFailureExplainsUdpBlocking()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new IOException("failed"),
            "No addressing information available for the endpoint", Iroh());
        Assert.Equal(ConnectionFailureKind.IrohDiscovery, failure.Kind);
        Assert.Contains("UDP", failure.Hint);
    }

    [Fact]
    public void IrohHostConnectionTimeoutExplainsDiscoveryPropagation()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new IOException("failed"), "host connection timed out", Iroh());
        Assert.Equal(ConnectionFailureKind.IrohDiscovery, failure.Kind);
    }

    [Fact]
    public void UnknownFailureKeepsTheRawMessage()
    {
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("something nobody classified"), null, Iroh());
        Assert.Equal(ConnectionFailureKind.Unknown, failure.Kind);
        Assert.Equal("something nobody classified", failure.Hint);
        Assert.False(failure.Repair);
    }

    // ---- adoptability: only direct transports can follow a moved address ----

    [Fact]
    public void IrohFailuresAreNeverAdoptable()
    {
        var error = new InvalidOperationException("无法解析主机 abc.iroh.localhost");
        Assert.False(ConnectionDiagnosis.IsAdoptable(error, Iroh()));
    }

    [Theory]
    [InlineData("lan", "192.168.1.18")]
    [InlineData("remote", "abc.cpolar.cn")]
    public void DirectTransportFailuresAreAdoptable(string channel, string host)
    {
        var error = new InvalidOperationException("无法连接");
        Assert.True(ConnectionDiagnosis.IsAdoptable(error, Direct(channel, host)));
    }

    [Fact]
    public void CaMismatchIsNotAdoptable()
    {
        // Following a new link would not fix a wrong-certificate anchor.
        var error = new InvalidOperationException("配对 CA 校验失败");
        Assert.False(ConnectionDiagnosis.IsAdoptable(error, Direct()));
    }

    [Fact]
    public void HttpStatusOutranksTheTransportErrorThatCarriedIt()
    {
        // A 429 arrives as a plain InvalidOperationException; it must not be reported as
        // a generic TLS or network problem.
        var failure = ConnectionDiagnosis.Diagnose(
            new InvalidOperationException("Gateway rejected auth: HTTP/1.1 429 Too Many Requests"),
            null, Direct("remote", "abc.cpolar.cn"));
        Assert.Equal(ConnectionFailureKind.RateLimited, failure.Kind);
    }
}
