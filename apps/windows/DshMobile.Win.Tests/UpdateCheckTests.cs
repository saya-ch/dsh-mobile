using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>Version comparison and release selection for the "检查更新" action.</summary>
public class UpdateCheckTests
{
    // ---- tag parsing ----

    [Theory]
    [InlineData("windows-v0.1.1", "0.1.1")]
    [InlineData("windows-v0.2.0-alpha", "0.2.0-alpha")]
    [InlineData("WINDOWS-V0.3.0", "0.3.0")]
    [InlineData("windows-v 0.4.0", "0.4.0")]
    public void ParsesWindowsClientTags(string tag, string expected)
    {
        Assert.Equal(expected, UpdateCheck.ParseTagVersion(tag));
    }

    [Theory]
    [InlineData("v0.8.13")]           // plugin tag, not a client release
    [InlineData("windows-0.1.0")]     // missing the v
    [InlineData("windows-v")]         // empty version
    [InlineData("")]
    [InlineData(null)]
    public void IgnoresTagsThatAreNotClientReleases(string? tag)
    {
        Assert.Null(UpdateCheck.ParseTagVersion(tag));
    }

    // ---- SemVer precedence ----

    [Theory]
    [InlineData("0.1.1", "0.1.0", true)]
    [InlineData("0.2.0", "0.1.9", true)]
    [InlineData("1.0.0", "0.9.9", true)]
    [InlineData("0.1.0", "0.1.0", false)]
    [InlineData("0.1.0", "0.1.1", false)]
    [InlineData("0.9.9", "1.0.0", false)]
    public void ComparesNumericCore(string candidate, string current, bool expected)
    {
        Assert.Equal(expected, UpdateCheck.IsNewer(candidate, current));
    }

    [Theory]
    [InlineData("0.1.1", "0.1", true)]      // shorter core pads with zeros
    [InlineData("0.1", "0.1.1", false)]
    [InlineData("0.1.0.0", "0.1.0", false)]
    public void PadsMissingCoreComponentsWithZero(string candidate, string current, bool expected)
    {
        Assert.Equal(expected, UpdateCheck.IsNewer(candidate, current));
    }

    [Theory]
    [InlineData("0.1.0", "0.1.0-alpha", true)]     // release outranks its prerelease
    [InlineData("0.1.0-alpha", "0.1.0", false)]    // prerelease never outranks the release
    [InlineData("0.1.1-alpha", "0.1.0", true)]     // higher core wins regardless
    [InlineData("0.2.0-beta", "0.2.0-alpha", true)]
    [InlineData("0.2.0-alpha", "0.2.0-beta", false)]
    [InlineData("0.2.0-alpha.2", "0.2.0-alpha.1", true)]
    [InlineData("0.2.0-alpha", "0.2.0-alpha.1", false)]
    public void OrdersPrereleasesLikeSemVer(string candidate, string current, bool expected)
    {
        Assert.Equal(expected, UpdateCheck.IsNewer(candidate, current));
    }

    [Fact]
    public void NumericPrereleaseSortsBelowAlphanumeric()
    {
        // SemVer: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
        Assert.True(UpdateCheck.IsNewer("1.0.0-alpha.1", "1.0.0-alpha"));
        Assert.True(UpdateCheck.IsNewer("1.0.0-alpha.beta", "1.0.0-alpha.1"));
        Assert.True(UpdateCheck.IsNewer("1.0.0-beta", "1.0.0-alpha.beta"));
    }

    [Fact]
    public void IgnoresBuildMetadata()
    {
        Assert.False(UpdateCheck.IsNewer("0.1.0+build.7", "0.1.0+build.3"));
        Assert.True(UpdateCheck.IsNewer("0.1.1+abc", "0.1.0+def"));
    }

    [Fact]
    public void ToleratesALeadingV()
    {
        Assert.True(UpdateCheck.IsNewer("v0.2.0", "0.1.0"));
        Assert.False(UpdateCheck.IsNewer("v0.1.0", "0.1.0"));
    }

    [Fact]
    public void UnparseableCandidateIsNeverNewer()
    {
        Assert.False(UpdateCheck.IsNewer("", "0.1.0"));
        Assert.False(UpdateCheck.IsNewer(null, "0.1.0"));
    }

    // ---- release selection ----

    private const string Releases = """
        [
          {
            "tag_name": "v0.8.13",
            "draft": false,
            "prerelease": false,
            "html_url": "https://github.com/saya-ch/dsh-mobile/releases/tag/v0.8.13",
            "assets": []
          },
          {
            "tag_name": "windows-v0.1.1",
            "draft": false,
            "prerelease": true,
            "html_url": "https://github.com/saya-ch/dsh-mobile/releases/tag/windows-v0.1.1",
            "assets": [
              { "name": "dsh-mobile-windows-v0.1.1-win-x64.zip.sha256",
                "browser_download_url": "https://example/sha256" },
              { "name": "dsh-mobile-windows-v0.1.1-win-x64.zip",
                "browser_download_url": "https://example/zip" }
            ]
          },
          {
            "tag_name": "windows-v0.1.0",
            "draft": false,
            "prerelease": true,
            "html_url": "https://example/old",
            "assets": []
          }
        ]
        """;

    [Fact]
    public void PicksTheNewestClientReleaseAndPrefersTheZipAsset()
    {
        var release = UpdateCheck.SelectLatest(Releases, "0.1.0-alpha");
        Assert.NotNull(release);
        Assert.Equal("windows-v0.1.1", release!.Tag);
        Assert.Equal("0.1.1", release.Version);
        Assert.Equal("https://example/zip", release.DownloadUrl);
        Assert.True(release.Prerelease);
    }

    [Fact]
    public void PluginTagsAreNeverOfferedAsAClientUpdate()
    {
        // v0.8.13 is far "newer" numerically but belongs to the plugin track.
        var release = UpdateCheck.SelectLatest(Releases, "0.1.0");
        Assert.NotNull(release);
        Assert.Equal("windows-v0.1.1", release!.Tag);
    }

    [Fact]
    public void UpToDateClientGetsNoUpdate()
    {
        Assert.Null(UpdateCheck.SelectLatest(Releases, "0.1.1"));
        Assert.Null(UpdateCheck.SelectLatest(Releases, "0.2.0"));
    }

    [Fact]
    public void DraftsAreNeverOffered()
    {
        const string json = """
            [
              { "tag_name": "windows-v0.9.0", "draft": true, "prerelease": false, "assets": [] }
            ]
            """;
        Assert.Null(UpdateCheck.SelectLatest(json, "0.1.0"));
    }

    [Fact]
    public void FallsBackToTheReleasePageWhenNoAssetExists()
    {
        const string json = """
            [
              { "tag_name": "windows-v0.2.0", "draft": false, "prerelease": false,
                "html_url": "https://example/page", "assets": [] }
            ]
            """;
        var release = UpdateCheck.SelectLatest(json, "0.1.0");
        Assert.Equal("https://example/page", release!.DownloadUrl);
    }

    [Fact]
    public void FallsBackToTheReleasesPageWhenThePayloadHasNoLink()
    {
        const string json = """
            [ { "tag_name": "windows-v0.2.0", "draft": false, "prerelease": false } ]
            """;
        var release = UpdateCheck.SelectLatest(json, "0.1.0");
        Assert.Equal(UpdateCheck.ReleasesPage, release!.DownloadUrl);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("not json")]
    [InlineData("{}")]          // object, not the array the API returns
    [InlineData("[]")]
    public void UnusablePayloadsYieldNoUpdate(string? json)
    {
        Assert.Null(UpdateCheck.SelectLatest(json, "0.1.0"));
    }

    [Fact]
    public void ReleasesWithoutATagAreSkipped()
    {
        const string json = """
            [
              { "draft": false, "assets": [] },
              { "tag_name": "windows-v0.2.0", "draft": false, "prerelease": false, "assets": [] }
            ]
            """;
        var release = UpdateCheck.SelectLatest(json, "0.1.0");
        Assert.Equal("0.2.0", release!.Version);
    }
}
