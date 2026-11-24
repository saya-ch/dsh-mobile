using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>WebView2 runtime detection, injected probe so no WebView2 types are needed.</summary>
public class WebView2AvailabilityTests
{
    [Theory]
    [InlineData("120.0.2210.91")]
    [InlineData("90.0.4430.212")]
    [InlineData("1.0.0.0")]
    public void AcceptsAParseableRuntimeVersion(string version)
    {
        Assert.True(WebView2Availability.IsAvailable(version));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not a version")]
    [InlineData("1.2.x")]
    public void RejectsMissingOrUnparseableVersions(string? version)
    {
        Assert.False(WebView2Availability.IsAvailable(version));
    }

    [Fact]
    public void DetectReturnsTheVersionWhenTheRuntimeExists()
    {
        Assert.Equal("120.0.2210.91", WebView2Availability.Detect(() => "120.0.2210.91"));
    }

    [Fact]
    public void DetectReturnsNullWhenTheRuntimeIsMissing()
    {
        // GetAvailableBrowserVersionString returns null when nothing is installed.
        Assert.Null(WebView2Availability.Detect(() => null));
    }

    [Fact]
    public void DetectSwallowsAProbeFailure()
    {
        // A missing WebView2Loader.dll throws DllNotFoundException; same outcome for the user.
        Assert.Null(WebView2Availability.Detect(() => throw new DllNotFoundException("WebView2Loader.dll")));
    }

    [Fact]
    public void MessageCarriesTheOfficialDownloadLink()
    {
        Assert.Equal("https://developer.microsoft.com/microsoft-edge/webview2",
            WebView2Availability.DownloadUrl);
        Assert.Contains(WebView2Availability.DownloadUrl, WebView2Availability.MissingMessage);
        Assert.Contains("WebView2", WebView2Availability.MissingMessage);
        Assert.False(string.IsNullOrWhiteSpace(WebView2Availability.MissingTitle));
    }

    [Fact]
    public void MessageMentionsTheX64Requirement()
    {
        // The client publishes win-x64 only; a mismatched runtime is a real support case.
        Assert.Contains("x64", WebView2Availability.MissingMessage);
    }
}
