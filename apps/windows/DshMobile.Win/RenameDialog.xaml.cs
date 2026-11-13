using System.Windows;

namespace DshMobile.Win;

/// <summary>Small modal dialog for renaming a saved computer. Name is display-only.</summary>
public partial class RenameDialog : Window
{
    internal string DeviceName { get; private set; } = string.Empty;

    internal RenameDialog(string currentName)
    {
        InitializeComponent();
        NameBox.Text = currentName;
        NameBox.SelectAll();
        Loaded += (_, _) => NameBox.Focus();
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        var name = NameBox.Text.Trim();
        if (name.Length == 0 || name.Length > 32 || name.Any(char.IsControl))
        {
            MessageBox.Show(this, "名称需为 1–32 个字符，且不能包含控制字符。",
                "名称无效", MessageBoxButton.OK, MessageBoxImage.Warning);
            NameBox.Focus();
            return;
        }
        DeviceName = name;
        DialogResult = true;
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) => DialogResult = false;
}
