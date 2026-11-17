using Xunit;

namespace DshMobile.Win.Tests;

public class WebViewPolicyTests
{
    private const string Gateway = "https://192.168.1.18:3443";

    [Theory]
    [InlineData("https://192.168.1.18:3443/mobile-access/pair")]
    [InlineData("https://192.168.1.18:3443/")]
    [InlineData("HTTPS://192.168.1.18:3443/x")]
    public void AcceptsExactOriginPaths(string url)
    {
        Assert.True(WebViewPolicy.IsSameGatewayOrigin(url, Gateway));
    }

    [Theory]
    [InlineData("https://192.168.1.18:9999/")]   // different port
    [InlineData("https://192.168.1.99:3443/")]   // different host
    [InlineData("https://192.168.1.18/")]        // default port is a different authority
    [InlineData("http://192.168.1.18:3443/")]    // not https
    [InlineData("https://evil.example/")]        // unrelated host
    [InlineData("not a url")]
    public void RejectsOtherOrigins(string url)
    {
        Assert.False(WebViewPolicy.IsSameGatewayOrigin(url, Gateway));
    }

    [Theory]
    [InlineData("not a gateway")]
    [InlineData("http://192.168.1.18:3443/")]
    public void RejectsBadGatewayOrigin(string gateway)
    {
        Assert.False(WebViewPolicy.IsSameGatewayOrigin("https://192.168.1.18:3443/", gateway));
    }
}
