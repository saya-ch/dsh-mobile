using System.Globalization;
using System.Runtime.CompilerServices;

namespace DshMobile.Win.Tests;

/// <summary>
/// Pins the test process to the neutral resource culture.
/// </summary>
/// <remarks>
/// Chinese is the neutral resource, so before this the assertions that compare user-facing
/// strings were implicitly asserting Chinese. Once satellite assemblies shipped, a machine
/// whose UI culture is English started resolving <c>Strings.Xxx</c> to English and those
/// assertions failed — on CI, and only there, because the developer machine happened to run
/// in Chinese. Pinning the culture here keeps every existing assertion meaningful and makes
/// the result independent of the machine's locale. Coverage for the other cultures lives in
/// <see cref="LocalizationTests"/>, which sets the culture explicitly.
/// </remarks>
internal static class TestCulture
{
    [ModuleInitializer]
    internal static void Initialize()
    {
        var neutral = CultureInfo.GetCultureInfo("zh-CN");
        CultureInfo.DefaultThreadCurrentCulture = neutral;
        CultureInfo.DefaultThreadCurrentUICulture = neutral;
        CultureInfo.CurrentCulture = neutral;
        CultureInfo.CurrentUICulture = neutral;
    }
}
