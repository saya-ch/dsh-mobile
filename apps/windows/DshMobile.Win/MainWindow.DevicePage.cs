using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using DshMobile.Win.Resources;

namespace DshMobile.Win;

/// <summary>
/// Presentation-only behaviour for the device list page: the brand mark, the empty
/// state's three pairing entry points, and the pairing panel's method tabs.
/// </summary>
/// <remarks>
/// This lives beside <c>MainWindow.Devices.cs</c> (card rendering, reachability,
/// ordering, undo) because neither belongs in the file that carries the connection
/// pipeline and the WebView policy. Nothing here touches connection state: the tabs
/// only change guidance text and which optional tool row is shown, so the single
/// paste box keeps accepting every descriptor format exactly as before.
/// </remarks>
public partial class MainWindow
{
    /// <summary>
    /// Shown under the paste box and in its placeholder, one wording per method. The
    /// three formats all land in the same box; only the guidance differs.
    /// </summary>
    private static (string Hint, string Placeholder) PairModeCopy(string mode) => mode switch
    {
        "remote" => (
            Strings.Pairing_ModeRemoteHint,
            Strings.Pairing_ModeRemotePlaceholder),
        "iroh" => (
            Strings.Pairing_ModeIrohHint,
            Strings.Pairing_ModeIrohPlaceholder),
        _ => (
            Strings.Pairing_ModeLanHint,
            Strings.Pairing_ModeLanPlaceholder),
    };

    private void DevicesPage_Loaded(object sender, RoutedEventArgs e)
    {
        // The icon choice is loaded after InitializeComponent, so the mark is resolved
        // here and again whenever the page becomes visible (the settings page can change
        // it in between).
        RefreshBrandMarks();
        DevicesScroll.IsVisibleChanged += (_, args) =>
        {
            if (args.NewValue is true) RefreshBrandMarks();
        };
        // The empty state replaces the list header: "已配对电脑" over an empty card reads
        // as a contradiction, and the card carries its own heading.
        NoDevicesText.IsVisibleChanged += (_, _) => SyncDevicesSection();
        SyncDevicesSection();
        ApplyPairMethod(PairModeLan);
    }

    /// <summary>
    /// The empty state replaces the list header: "已配对电脑" over an empty card reads as
    /// a contradiction, and the card carries its own heading.
    /// </summary>
    private void SyncDevicesSection() =>
        SectionHeader.Visibility = NoDevicesText.Visibility == Visibility.Visible
            ? Visibility.Collapsed
            : Visibility.Visible;

    private void RefreshBrandMarks()
    {
        var image = AppIcons.LoadImage(_appIcon);
        if (image is null)
        {
            // No artwork beside the executable: keep the layout, drop the images.
            BrandMark.Visibility = Visibility.Collapsed;
        }
        else
        {
            BrandMark.Source = image;
        }
        // Build metadata after '+' is not a version number a user can compare.
        var informational = typeof(MainWindow).Assembly
            .GetCustomAttribute<System.Reflection.AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion
            ?? typeof(MainWindow).Assembly.GetName().Version?.ToString(3) ?? "0.1.0";
        BrandVersion.Text = "Windows · " + informational.Split('+')[0];
    }

    private void PairMethod_Checked(object sender, RoutedEventArgs e)
    {
        // Checked also fires while the XAML is still being built, before the controls
        // this method writes to exist. The Loaded handler applies the default again.
        if (PairModeHint is null || DiscoveryToggle is null
            || DiscoveryPanel is null || DescriptorPlaceholder is null)
            return;
        ApplyPairMethod(sender);
    }

    private void ApplyPairMethod(object? sender)
    {
        var mode = ReferenceEquals(sender, PairModeRemote) ? "remote"
            : ReferenceEquals(sender, PairModeIroh) ? "iroh"
            : ReferenceEquals(sender, PairModeLan) ? "lan"
            : PairModeIroh?.IsChecked == true ? "iroh"
            : PairModeRemote?.IsChecked == true ? "remote"
            : "lan";

        var (hint, placeholder) = PairModeCopy(mode);
        PairModeHint.Text = hint;
        DescriptorPlaceholder.Text = placeholder;

        // Local discovery only makes sense for a link that resolves on this network;
        // the other two methods keep a single, uncluttered column.
        var lan = mode == "lan";
        DiscoveryToggle.Visibility = lan ? Visibility.Visible : Visibility.Collapsed;
        if (!lan)
        {
            DiscoveryPanel.Visibility = Visibility.Collapsed;
            DiscoveryToggle.Content = Strings.Pairing_FindOnThisPc;
        }
    }

    private void DiscoveryToggle_Click(object sender, RoutedEventArgs e)
    {
        var reveal = DiscoveryPanel.Visibility != Visibility.Visible;
        DiscoveryPanel.Visibility = reveal ? Visibility.Visible : Visibility.Collapsed;
        DiscoveryToggle.Content = reveal ? Strings.Pairing_HideFinder : Strings.Pairing_FindOnThisPc;
        if (reveal) AddressBox.Focus();
    }

    /// <summary>
    /// Empty-state method chips select the matching tab and bring the paste box into
    /// view, so the guidance and the input are always the same decision.
    /// </summary>
    private void EmptyMethod_Click(object sender, RoutedEventArgs e)
    {
        var mode = (sender as FrameworkElement)?.Tag as string ?? "lan";
        var tab = mode switch
        {
            "remote" => PairModeRemote,
            "iroh" => PairModeIroh,
            _ => PairModeLan,
        };
        if (tab is not null) tab.IsChecked = true;
        ShowAddPanel(true);
        AddPanel.BringIntoView();
        Dispatcher.BeginInvoke(new Action(() =>
        {
            DescriptorBox.BringIntoView();
            DescriptorBox.Focus();
        }), DispatcherPriority.Input);
    }
}
