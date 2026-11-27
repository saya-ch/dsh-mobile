# Windows client strings

Every user-visible string of `DshMobile.Win` lives in [`Strings.resx`](Strings.resx) and is read
through the hand-written accessor in [`Strings.Designer.cs`](Strings.Designer.cs).

Chinese is the **default** language: the neutral resource set that ships in this folder is the
exact text the interface had while it was hard-coded, so the UI is unchanged and no translation
exists yet. A translation is added as a satellite file (`Strings.<culture>.resx`) beside this one;
the neutral values are never rewritten, so an untranslated build keeps rendering Chinese.

## How code reads a string

```csharp
// C#
using DshMobile.Win.Resources;
MessageBox.Show(Strings.Settings_ClearDone, Strings.Settings_ClearSiteData, ...);
SetUpdateText(string.Format(Strings.Update_To, release.Version), error: false);
```

```xml
<!-- XAML: one namespace declaration per file, then x:Static on the attribute -->
xmlns:res="clr-namespace:DshMobile.Win.Resources"
<TextBlock Text="{x:Static res:Strings.DeviceList_EmptyTitle}" />
```

The choice is `{x:Static}` everywhere, deliberately:

* it is compile-checked (a missing key or a renamed property fails the build, unlike a
  string-keyed markup extension),
* it needs no view-model plumbing for the many one-line labels in this client,
* it keeps the XAML readable: the key names the string's role, not its text.

**Limitation:** `{x:Static}` is evaluated once, when the element is loaded. Changing
`CultureInfo.CurrentUICulture` at runtime does *not* repaint an existing window. A future
language switch needs one of:

1. rebuild the windows after setting the culture (`new MainWindow()` / dialog reopen), which is
   enough for this client because both windows are cheap and the device list is rebuilt on every
   change anyway, or
2. move the strings to `DynamicResource` entries (a `ResourceDictionary` per culture) or to
   view-model properties with change notification.

`Manager.GetString(..., CultureInfo.CurrentUICulture)` already falls back to the neutral Chinese
set for every culture without a satellite assembly, so nothing else has to change for (1).

## Adding a key

Add it to `Strings.resx` (PascalCase, grouped by screen prefix: `DeviceList_`, `Pairing_`,
`Connect_`, `Diagnosis_`, `Settings_`, `Update_`, ...), then add the matching property to
`Strings.Designer.cs`. The accessor is hand-written rather than produced by
`ResXFileCodeGenerator` so a build needs no Visual Studio designer round-trip. Each `<data>`
element carries a `<comment>` naming the screen the string appears on.

Placeholders are `{0}`, `{1}` and are filled with `string.Format` at the call site.

## Deliberately not in the resource file

`ConnectionDiagnosis` and `BackgroundEventWatcher` still contain a handful of Chinese string
literals. They are **matching tokens**, not UI copy: they recognise what a gateway or the iroh
sidecar reported (e.g. `message.Contains("无法解析主机")`). Translating them would stop them
matching. They do depend on the wording this client itself produces, so if that wording changes,
the tokens must change with it — a protocol code would be the sturdier long-term fix.
