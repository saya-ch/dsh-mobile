using System;
using System.Text;
using DshMobile.Win;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// The four answers the probe can give, and what each one means.
/// </summary>
/// <remarks>
/// Every outcome here maps to a different row in the device list, so they are pinned against
/// the exact bytes the gateway sends (see the gateway's native-probe tests): 200 with an
/// instance id, 401 for an unknown or revoked credential.
/// </remarks>
public class ProbeResponseTests
{
    private const string InstanceId = "a1b2c3";

    private static byte[] Response(string statusLine, string body, params string[] extraHeaders)
    {
        var builder = new StringBuilder();
        builder.Append(statusLine).Append("\r\n");
        builder.Append("Content-Type: application/json\r\n");
        foreach (var header in extraHeaders) builder.Append(header).Append("\r\n");
        builder.Append("Content-Length: ").Append(Encoding.UTF8.GetByteCount(body)).Append("\r\n");
        builder.Append("Connection: close\r\n\r\n");
        builder.Append(body);
        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    [Fact]
    public void A200ReturnsTheInstanceId()
    {
        var raw = Response("HTTP/1.1 200 OK",
            $"{{\"instanceId\":\"{InstanceId}\",\"deviceId\":\"d1\",\"deviceExpiresAt\":99}}");
        Assert.Equal(InstanceId, GatewayAuth.ParseProbeResponse(raw));
    }

    [Theory]
    [InlineData("HTTP/1.1 401 Unauthorized")]
    [InlineData("HTTP/1.1 403 Forbidden")]
    public void ARejectedCredentialIsItsOwnOutcome(string statusLine)
    {
        var raw = Response(statusLine, "{\"error\":\"authentication_failed\"}");
        Assert.Throws<GatewayAuth.ProbeRejectedException>(() => GatewayAuth.ParseProbeResponse(raw));
    }

    [Fact]
    public void AMissingEndpointIsItsOwnOutcome()
    {
        // An older gateway without the probe endpoint; the caller falls back to discovery.
        var raw = Response("HTTP/1.1 404 Not Found", "{\"error\":\"not_found\"}");
        Assert.Throws<GatewayAuth.ProbeUnsupportedException>(() => GatewayAuth.ParseProbeResponse(raw));
    }

    [Fact]
    public void AnyOtherFailureIsNeitherReachableNorRejected()
    {
        // A 500 must not be read as "revoked": that would tell the user to re-pair a computer
        // that is merely unhappy right now.
        var raw = Response("HTTP/1.1 500 Internal Server Error", "{\"error\":\"boom\"}");
        var error = Assert.Throws<InvalidOperationException>(() => GatewayAuth.ParseProbeResponse(raw));
        Assert.DoesNotContain("revoked", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AReplyWithoutAnInstanceIdIsNotAccepted()
    {
        var raw = Response("HTTP/1.1 200 OK", "{\"deviceId\":\"d1\"}");
        Assert.Throws<InvalidOperationException>(() => GatewayAuth.ParseProbeResponse(raw));
    }
}