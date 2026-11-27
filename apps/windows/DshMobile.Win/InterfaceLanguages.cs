using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace DshMobile.Win;

/// <summary>
/// The interface languages the client ships, and how the stored preference maps to a culture.
/// </summary>
/// <remarks>
/// Chinese is the neutral resource, so it has no satellite file; the rest match
/// <c>Resources/Strings.&lt;culture&gt;.resx</c>. A culture with no satellite falls back to
/// Chinese at lookup time, which is why an unknown stored value is treated as "follow the
/// system" rather than trusted blindly.
/// </remarks>
internal static class InterfaceLanguages
{
    internal sealed record Option(string Culture, string NativeName);

    /// <summary>Ordered as they appear in the picker; the first entry follows Windows.</summary>
    internal static readonly IReadOnlyList<Option> All = new[]
    {
        new Option(AppSettings.LanguageSystem, "跟随系统"),
        new Option("zh-CN", "简体中文"),
        new Option("en", "English"),
        new Option("ja", "日本語"),
        new Option("ko", "한국어"),
        new Option("es", "Español"),
        new Option("fr", "Français"),
        new Option("de", "Deutsch"),
        new Option("it", "Italiano"),
    };

    /// <summary>Resolve the stored preference to the culture the UI should render in.</summary>
    internal static CultureInfo Resolve(string? stored)
    {
        if (string.IsNullOrWhiteSpace(stored) || stored == AppSettings.LanguageSystem)
            return CultureInfo.InstalledUICulture;
        // GetCultureInfo does not reject an unknown name: "not-a-culture" returns a culture
        // called "not", which no satellite matches. Only the shipped set is accepted.
        if (!All.Any(option => option.Culture == stored))
            return CultureInfo.InstalledUICulture;
        try
        {
            return CultureInfo.GetCultureInfo(stored);
        }
        catch (CultureNotFoundException)
        {
            // A hand-edited or stale value must not leave the client in an unknown language.
            return CultureInfo.InstalledUICulture;
        }
    }

    /// <summary>Apply a preference to the current thread and to threads created later.</summary>
    internal static void Apply(string? stored)
    {
        var culture = Resolve(stored);
        CultureInfo.DefaultThreadCurrentUICulture = culture;
        CultureInfo.DefaultThreadCurrentCulture = culture;
        CultureInfo.CurrentUICulture = culture;
        CultureInfo.CurrentCulture = culture;
    }

    /// <summary>The stored value that matches the current UI culture, for showing a selection.</summary>
    internal static string CurrentSelection(string? stored) =>
        All.Any(option => option.Culture == stored) ? stored! : AppSettings.LanguageSystem;
}
