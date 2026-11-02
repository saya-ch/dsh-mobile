# Skins and mobile layout

[简体中文](SKIN_COMPATIBILITY.md) · [Third-party plugins](../README.en.md#third-party-plugin-compatibility)

DSH Mobile uses a dedicated root layout on the authenticated mobile page while retaining DSH conversations, sidebars, settings and public slots. The computer page is unchanged. Components can still consume public theme variables, but backgrounds, characters and sidebar decorations tied to stock CSS-module classes or specific parents may not apply.

## Keep the computer skin, change only the phone

Open **Settings → General → Mobile page modules → Manage** on the phone and find the skin's client module. If optional, deselect it and save. This choice affects only the current paired device: it does not uninstall the computer plugin, change other devices or reload a conversation automatically. Manually reopen or refresh the page to apply it.

If saving reports a dependency conflict, retain the required module or also deselect its unwanted consumers. Bootstrap-required modules cannot be excluded. The phone's Restore defaults action returns to computer defaults, not necessarily to loading every module. See [module management](CLIENT_MODULES.en.md).

## Diagnose a missing background

- Identify the running plugin, App and skin versions; plugin and App versions need not match.
- When text and controls are oversized throughout the page, check [mobile font size and App page zoom](MOBILE_COMPOSER_TOOLBAR.en.md#display-size-and-available-space) and compare defaults before attributing it to layout. Terminals and third-party controls may not consume the same font settings.
- Omit the skin only on this device, reopen manually and compare the conversation, composer and sidebar. Recovery points to styles or mounting, not necessarily a network or pairing failure.
- First compare the normal computer layout. Developers can also open `/?frontend=stock` on the authenticated mobile Origin to diagnose boot and layout behavior. Gateway authentication and HTTPS checks remain; this entry skips dedicated mobile boot rewriting and module selection, but installed client adaptation and authenticated customizations may still apply. It is not a plugin-free control; some API operations may be rejected, so it does not replace normal mobile access.
- When stock has a background but mobile does not, inspect the skin's mounting container and fallback for other layouts. WebSocket approval, APK reinstallation or making every container transparent cannot guarantee a fix.
- A see-through sidebar, unreadable text shadows and an empty trace need separate diagnosis, not a single missing-background explanation. For an empty trace, inspect the first client exception, actual layout dimensions and whether its module loaded. A static screenshot does not distinguish rendering failure, occlusion and connection failure.
- **The mobile chrome does not depend on the skin**: the drawer, the right detail panel and the panel return bar composite `--dsw-alias-bg-layer-1` (the return bar uses `--dsw-alias-bg-base`) over the opaque CSS `Canvas` system color. A skin that makes those tokens translucent, or leaves them unresolvable, no longer shows conversation text behind the sidebar labels; a still see-through surface then comes from the skin's own decoration layer, not the chrome base.
- **Page-level styles injected by a skin travel with the page**: wallpapers and whole-page palettes are injected into the HTML by the plugin on the host, so deselecting that skin's client module does not remove them (module selection covers client modules only). Disable the whole plugin to stop loading them.

For example, the published `maid-atelier` 0.1.7 package mounts its background in the stock `centerCol` container. Its repository's fallback for other layouts does not establish that an installed package contains the same correction. DSH Mobile does not imitate that class or move the skin's nodes. A skin supporting mobile can locate its decoration with the existing `[data-pane="conversation"]` and `[data-pane="sidebar"]` markers, or use DSH public theme variables. The skin must still own sizing, stacking, cleanup and light/dark behavior without obscuring text or hit targets. This guide does not establish full skin acceptance. See [#202](https://github.com/saya-ch/dsh-mobile/issues/202).

An isolated DSH 0.2.0-rc.2 combination with Mobile 0.6.4 and the published npm `maid-atelier` 0.1.7 reproduces the see-through navy sidebar, unreadable dark labels, missing background and a blank populated Trajectory view. The trace data remains present: a broad skin rule changes the mobile root to a column Flex layout and collapses the content region to zero height. Plugin 0.6.5 protects the plugin-owned root's Grid geometry and fixes this blank trace, without changing the skin's palette, shadows or decoration mounting.

This skin binds light sidebar labels to the stock `sidebarCol`, absent from the mobile layout. Missing backgrounds and some text-contrast problems still need skin adaptation; the trace fix does not resolve them. Device-level selection stops optional client modules from loading, not host-injected page styles, so it does not guarantee a default appearance. This device setting does not change the computer's installed plugins or loading choices. Plugin 0.6.4 and earlier do not contain the layout protection.
