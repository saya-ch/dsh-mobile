using System;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// Reads what a PrimaryButton's Foreground actually resolves to.
/// </summary>
/// <remarks>
/// The rendered connect button showed a #1D1D1F label on a blue fill — the body text colour,
/// roughly 3.2:1 — while the style declares Foreground = OnAccentBrush (#FFFFFF). Guessing at
/// the cause was unproductive, so this asserts the resolved value directly: a style that
/// stops resolving, or an OnAccentBrush that turns dark, fails here.
/// </remarks>
public class ButtonContrastTests
{
    private static readonly object Gate = new();
    private static bool _applicationReady;

    private static T OnStaThread<T>(Func<T> work)
    {
        T result = default!;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { result = work(); }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) throw failure;
        return result;
    }

    private static void EnsureApplication()
    {
        lock (Gate)
        {
            if (_applicationReady) return;
            var app = new DshMobile.Win.App();
            app.InitializeComponent();
            _applicationReady = true;
        }
    }

    private static Color ResolveLabelColour()
    {
        EnsureApplication();
        var resources = Application.Current!.Resources;
        var style = (Style)resources["PrimaryButton"];
        var button = new Button { Style = style };
        // Force property resolution without needing a visual tree.
        button.ApplyTemplate();

        if (button.Foreground is not SolidColorBrush solid)
            throw new Xunit.Sdk.XunitException("PrimaryButton.Foreground is not a solid colour");
        return solid.Color;
    }

    [Fact]
    public void PrimaryButtonLabelResolvesToTheOnAccentColour()
    {
        var colour = OnStaThread(ResolveLabelColour);
        Assert.Equal(Color.FromRgb(0xFF, 0xFF, 0xFF), colour);
    }

    [Fact]
    public void PrimaryButtonLabelIsLight()
    {
        var colour = OnStaThread(ResolveLabelColour);
        var luminance = (0.2126 * colour.R + 0.7152 * colour.G + 0.0722 * colour.B) / 255.0;
        Assert.True(luminance > 0.7, $"label luminance {luminance:F2} is too dark for a blue fill");
    }

    [Fact]
    public void OnAccentResourceItselfIsWhite()
    {
        var colour = OnStaThread(() =>
        {
            EnsureApplication();
            var brush = (SolidColorBrush)Application.Current!.Resources["OnAccentBrush"];
            return brush.Color;
        });
        Assert.Equal(Color.FromRgb(0xFF, 0xFF, 0xFF), colour);
    }
}
