using System;
using System.Globalization;
using System.Resources;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// Asserts that each shipped satellite actually resolves, which a successful build does not
/// prove: a satellite whose logical name or folder is wrong compiles fine and silently falls
/// back to the neutral resource.
/// </summary>
public class LocalizationTests
{
    // The resources live in the client assembly, not the test one; resolving against the
    // test assembly finds nothing and every lookup returns null.
    private static readonly ResourceManager Manager = new(
        "DshMobile.Win.Resources.Strings", typeof(DshMobile.Win.Resources.Strings).Assembly);

    private static string? Read(string key, string culture)
    {
        var previous = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(culture);
            return Manager.GetString(key, CultureInfo.CurrentUICulture);
        }
        finally
        {
            CultureInfo.CurrentUICulture = previous;
        }
    }

    [Theory]
    [InlineData("en", "Settings")]
    [InlineData("ja", "設定")]
    [InlineData("ko", "설정")]
    [InlineData("es", "Configuración")]
    [InlineData("fr", "Paramètres")]
    [InlineData("de", "Einstellungen")]
    [InlineData("it", "Impostazioni")]
    public void NavigationLabelIsTranslated(string culture, string expected)
    {
        Assert.Equal(expected, Read("Nav_Settings", culture));
    }

    [Fact]
    public void NeutralResourceStaysChinese() =>
        Assert.Equal("设置", Read("Nav_Settings", "zh-CN"));

    [Fact]
    public void UnknownCultureFallsBackToChinese() =>
        // A language without a satellite must still render, not show blanks.
        Assert.Equal("设置", Read("Nav_Settings", "pt-BR"));

    [Theory]
    [InlineData("en")]
    [InlineData("ja")]
    [InlineData("ko")]
    [InlineData("es")]
    [InlineData("fr")]
    [InlineData("de")]
    [InlineData("it")]
    public void PlaceholdersSurviveTranslation(string culture)
    {
        // A dropped or renamed placeholder is a FormatException at runtime, not a visible
        // typo, so every culture is checked rather than just the neutral one.
        var template = Read("Update_ProgressPercent", culture);
        Assert.NotNull(template);
        Assert.Contains("{0}", template);
        Assert.Contains("{1}", template);
        Assert.Contains("{2}", template);
    }
}
