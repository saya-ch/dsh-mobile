using System;
using System.Globalization;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// Covers the interface-language preference: which culture a stored value resolves to, and
/// that an unusable value cannot leave the client in a language it does not ship.
/// </summary>
public class InterfaceLanguageTests
{
    [Theory]
    [InlineData("system")]
    [InlineData("")]
    [InlineData(null)]
    public void UnknownPreferenceFollowsTheSystem(string? stored)
    {
        var resolved = InterfaceLanguages.Resolve(stored);
        Assert.Equal(CultureInfo.InstalledUICulture, resolved);
    }

    [Theory]
    [InlineData("ja")]
    [InlineData("de")]
    [InlineData("zh-CN")]
    public void KnownPreferenceResolvesToThatCulture(string stored)
    {
        var resolved = InterfaceLanguages.Resolve(stored);
        Assert.Equal(stored, resolved.Name);
    }

    [Fact]
    public void AnUnknownCultureNameFallsBackInsteadOfThrowing()
    {
        // A hand-edited settings.json must not break the client on startup.
        var resolved = InterfaceLanguages.Resolve("not-a-culture");
        Assert.Equal(CultureInfo.InstalledUICulture, resolved);
    }

    [Fact]
    public void EveryShippedOptionResolves()
    {
        // The picker lists options the client must be able to render.
        foreach (var option in InterfaceLanguages.All)
        {
            var resolved = InterfaceLanguages.Resolve(option.Culture);
            Assert.NotNull(resolved);
        }
    }

    [Fact]
    public void EveryOptionExceptSystemHasAShippedSatellite()
    {
        // Chinese is the neutral resource and lives in the client assembly itself, so it has
        // no satellite file. Every other entry needs one, or the picker would offer a
        // language the client cannot show.
        var outputRoot = AppContext.BaseDirectory;
        foreach (var option in InterfaceLanguages.All)
        {
            if (option.Culture == AppSettings.LanguageSystem) continue;
            if (option.Culture == "zh-CN")
            {
                // The neutral resource resolves without any satellite.
                Assert.Equal("设置", ResourceFor("Nav_Settings", "zh-CN"));
                continue;
            }
            var satellite = Path.Combine(outputRoot, option.Culture, "DshMobile.Win.resources.dll");
            Assert.True(File.Exists(satellite),
                $"no satellite assembly for {option.Culture} at {satellite}");
        }
    }

    private static string ResourceFor(string key, string culture)
    {
        var manager = new System.Resources.ResourceManager(
            "DshMobile.Win.Resources.Strings", typeof(DshMobile.Win.Resources.Strings).Assembly);
        var previous = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(culture);
            return manager.GetString(key, CultureInfo.CurrentUICulture) ?? string.Empty;
        }
        finally
        {
            CultureInfo.CurrentUICulture = previous;
        }
    }

    [Fact]
    public void TheSystemEntryIsTheFirstOption()
    {
        Assert.Equal(AppSettings.LanguageSystem, InterfaceLanguages.All[0].Culture);
    }
}
