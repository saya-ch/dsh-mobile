using System;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;

namespace DshMobile.Win;

/// <summary>
/// The language picker's behaviour: fill it, remember the choice, and rebuild the window.
/// </summary>
/// <remarks>
/// A live culture change cannot repaint the shell, because the strings are bound with
/// <c>{x:Static}</c> and resolve once when each element loads. Rebuilding the window is
/// therefore the honest way to apply a language, and it is also what the settings hint
/// promises the user. The stored preference is written first, so a rebuild that fails still
/// leaves the next launch in the chosen language.
/// </remarks>
public sealed partial class MainWindow
{
    private bool _suppressLanguageEvent;

    /// <summary>Populate the picker and show the stored choice.</summary>
    private void SyncLanguageControls()
    {
        if (LanguagePicker is null) return;
        _suppressLanguageEvent = true;
        try
        {
            LanguagePicker.ItemsSource = InterfaceLanguages.All
                .Select(option => new LanguagePickerItem(option.Culture, option.NativeName))
                .ToList();
            // Read through _settings, which the window loaded from <root>/data/settings.json.
            // Using AppContext.BaseDirectory here would write a second, conflicting copy at
            // the program root — and fail silently wherever that folder is not writable.
            var selection = InterfaceLanguages.CurrentSelection(_settings.Language);
            LanguagePicker.SelectedItem = ((System.Collections.IEnumerable)LanguagePicker.ItemsSource!)
                .Cast<LanguagePickerItem>()
                .FirstOrDefault(item => item.Culture == selection);
        }
        finally
        {
            _suppressLanguageEvent = false;
        }
    }

    private void LanguagePicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressLanguageEvent) return;
        if (LanguagePicker.SelectedItem is not LanguagePickerItem item) return;
        if (item.Culture == _settings.Language) return;

        _settings.Language = item.Culture;
        _settings.Save(DataRoot);

        // Apply now, so the rebuilt window comes up in the new language without a restart.
        InterfaceLanguages.Apply(item.Culture);
        RebuildForLanguage();
    }

    /// <summary>Reopen the shell in the new language, in the same place and at the same size.</summary>
    /// <remarks>
    /// The replacement is a new window with no owner, so the shell cannot let WPF choose a
    /// position: CenterOwner without an Owner falls back to the default placement, which
    /// moved the window toward the bottom-right, and a missing size dropped whatever the
    /// user had resized to. RestoreBounds is the right source when maximised, because Left
    /// and Top then describe the maximised frame rather than the size to restore.
    /// </remarks>
    private void RebuildForLanguage()
    {
        var wasSettings = SettingsRailButton.IsChecked == true;
        var bounds = WindowState == WindowState.Normal
            ? new Rect(Left, Top, ActualWidth, ActualHeight)
            : RestoreBounds;

        var window = new MainWindow
        {
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = bounds.Left,
            Top = bounds.Top,
            Width = bounds.Width,
            Height = bounds.Height,
            WindowState = WindowState,
        };
        window.Show();
        window.Activate();
        Close();
        if (wasSettings) window.ShowSettingsPage(true);
    }

    /// <summary>One entry in the language picker.</summary>
    private sealed record LanguagePickerItem(string Culture, string NativeName)
    {
        public override string ToString() => NativeName;
    }
}
