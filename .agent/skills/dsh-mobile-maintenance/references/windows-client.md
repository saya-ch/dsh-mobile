# Windows desktop client

The portable client (`apps/windows/`) is a WPF + WebView2 shell around the same authenticated Mobile page the phone opens. Read [ARCHITECTURE](../../../../apps/windows/ARCHITECTURE.md) for the connection channels, trust model and WebView2 boundary policy and [README](../../../../apps/windows/README.md) for build commands and the current support matrix. Windows x64 only: no Linux/macOS build, and no architecture fallback to claim.

## Desktop is its own surface, not Android at a larger size

The Windows shell keeps the design system's roles but derives its own color steps, radii and hit targets from [the Windows surface scale](../../../../design-system/dsh-mobile/MASTER.md#windows-desktop-surface-scale). Its dark palette deliberately does **not** mirror the Android `#0F172A / #1E293B / #475569`: at 1600px those read as one flat blue and a `#475569` border is brighter than the card it frames. Its radii and targets are DIP values one step tighter than the Android dp values, because the desktop sits closer to the eye and a 20-radius card at 1000px width reads as a bubble; the rail destinations are 60×54 DIP for the same reason.

Decision: change a Windows visual value in MASTER's Windows section and in the brushes together — light colors in [App.xaml](../../../../apps/windows/DshMobile.Win/App.xaml), both palettes in [App.xaml.cs](../../../../apps/windows/DshMobile.Win/App.xaml.cs) (`ApplyLightPalette` / `ApplyDarkPalette`) — and do not restore the Android values into the desktop shell. A "fix" that copies the phone's `#1E293B` card or 16–20 card radius back into the client is a regression, not alignment.

The shell also stays out of the page: its chrome is window-level native controls, it injects no script and restyles no DOM, and the page's own behavior belongs to the plugin. A client change that starts modifying the loaded document changes which product owns that behavior.

Acceptance: in dark mode the rail sits below the canvas and the card above it, borders stay dimmer than the surface they frame, the shadow is neutral black rather than a navy halo, and every value in MASTER's Windows table equals the brush the client applies. Both palettes are installed by replacing whole brush resources (WPF freezes dictionary brushes), so a new token belongs in both lists and is referenced with `DynamicResource`; mutating a frozen brush or hardcoding `StaticResource` leaves the other theme on screen.

## Review desktop layout at the logical size

WPF geometry is DIPs; a screenshot is physical pixels. On a 2560×1600 display at 200% (1280×800 DIP), a 1280×1040 px capture of a maximized window is a 640 DIP window — phone width. Reviewing that capture produces confident but wrong findings ("content only fills the left third", "the layout is broken") that are capture-scale errors, not product defects.

Decision: make the reviewing process DPI-aware before reading the screen (`SetProcessDPIAware()`, so `Screen.PrimaryScreen.Bounds` reports physical pixels), divide the bounds by the display's scale factor, maximize the window, and record both the captured pixel size and the DIP size.

Acceptance: captured width ÷ scale factor matches the window's own `ActualWidth` within a few DIP of chrome, and the resulting DIP width is plausible for the monitor (a maximized window on a 1280-DIP screen is ~1280 DIP wide). If the divided width is near half the screen or below the window's `MinWidth`, discard the capture instead of filing a layout bug. Compare against the layout owners in DIPs: [MainWindow.xaml](../../../../apps/windows/DshMobile.Win/MainWindow.xaml) declares the default 1280×880 window, `MinWidth`/`MinHeight` 520, and the `MaxWidth=1000` content column.

## One writer owns `data\settings.json`

[AppSettings](../../../../apps/windows/DshMobile.Win/AppSettings.cs) is the only serializer of `settings.json`: it writes the complete PascalCase object through a temporary file and falls back to defaults for a missing or damaged file. A second writer that serializes only its own key replaces the whole document, so one icon switch erases the theme, start behaviour and notification preferences.

Decision: a new preference is a property on `AppSettings`, loaded and saved through it, with a default that also applies when the file is absent. Do not add a per-feature JSON file or a second writer "to avoid touching the shared one".

Acceptance: changing one preference and restarting leaves every other persisted value as it was; the file contains exactly the properties `AppSettings` declares; a deleted or truncated file starts the client with defaults instead of failing.

## Icons ship per-size artwork

`icons/` holds multi-frame ICOs whose small frames are a simplified whale mark and whose ≥32px frames are the character artwork. A detailed portrait at 16–24px collapses into a few pixels and reads as a blue block, so the simplified mark is the small-size artwork, not a placeholder. [AppIcons](../../../../apps/windows/DshMobile.Win/AppIcons.cs) requests the largest frame for previews (a plain `BitmapImage` over an ICO decodes the smallest, which upscaled a 16px frame) and streams tray artwork so the file handle does not block replacing the icon at runtime.

Acceptance: inspect the icon's 16, 24, 32 and 48 px frames and the actual titlebar, tray and taskbar renderings after switching icons; a replaced icon file must keep its small-size frame rather than shipping one full-resolution drawing in every frame.

## Hot files: one writer at a time

`MainWindow.xaml`, `MainWindow.xaml.cs`, `MainWindow.*.cs`, `App.xaml` and `AppSettings.cs` are single-file build inputs with no conflict detection. Concurrent writes to one of them produce a run of build failures (unclosed element, type mismatch, missing member) that costs more rounds than the change itself, and each failure masks the next.

Decision: when several Agents work on this tree, give each one a disjoint file or region; on a shared file prefer a targeted edit over a whole-file rewrite, state which region you hold, and build immediately after each edit. Treat the last green build as the baseline to return to.

Acceptance: `dotnet build apps/windows/DshMobile.Win/DshMobile.Win.csproj -c Release` succeeds at every handoff, the integrating Agent's final diff contains no interleaved half-edits, and the unit tests still run afterwards. [Collaboration and releases](collaboration-and-releases.md#concurrent-maintainer-edits) owns the general write-scope rule.

## Build evidence and the release track

Build and unit tests are source checks: `dotnet build` plus the xunit project under `DshMobile.Win.Tests/`, which covers parsing, pairing/trust policy, storage, discovery and the WebView policy — no WebView2 process, no window, no connection. [The client workflow](../../../../.github/workflows/windows-client.yml) runs the same steps on `windows-latest` and produces no package; the portable zip comes only from the tag-gated Windows release workflow. That publish step assembles a self-contained win-x64 folder, deliberately leaves the sidecar out (the client downloads and verifies the pinned component at first use), and puts `LICENSE`, `THIRD_PARTY_NOTICES.md` and both READMEs inside the folder so it is self-describing.

State which of build, unit tests, packed run, and per-channel acceptance were actually executed. CI green is not WebView2, device, pairing or channel acceptance, and a source test is not evidence about the rendered shell.

[Collaboration and releases](collaboration-and-releases.md#independent-versions) owns tag/version independence, the publication gate and post-publication verification.
