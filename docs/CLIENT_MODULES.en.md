# Mobile page modules

[中文](CLIENT_MODULES.md) · [Back to README](../README.en.md#optional-modules-and-advanced-configuration)

> Module management has been available since plugin 0.6.0; the search, grouping and recovery improvements below require plugin 0.6.5 or later. Plugin and App version numbers need not match.

Choose which client components the dedicated mobile page loads. This does not uninstall computer plugins, stop their services, or restrict device permissions. A paired device remains a trusted DSH operator.

Selection applies to whole module IDs, not individual buttons, cards or sidebars inside a module. A plugin may register several modules or share/depend on a module with other features. A feature not delivered as an optional client module may not be independently removable here.

The selection covers client modules only. A plugin may also inject page-level styles from the host into every page — wallpapers and whole-page palettes are the usual case. That content is not a client module, so deselecting one does not remove it: disable the whole plugin, or let the plugin adapt itself to the mobile layout. See [skins and mobile layout](SKIN_COMPATIBILITY.en.md) for skin diagnosis.

## Computer defaults and this device

- On the **computer: Settings → General → Mobile page modules → Manage**, set defaults for this computer's mobile access. Enable a LAN or remote access entry first so the current DSH module catalog can be read.
- On the **phone: Settings → General → Mobile page modules → Manage**, override only the currently authenticated paired device. This cannot change another phone or the computer default.

Selection precedence is: device override → computer default → the profile's `excludedClientModules` configuration. Without custom selections, no modules are excluded. LAN and remote entries share the computer default. Device overrides belong to pairing identities; independent LAN and remote pairings on the same phone do not automatically share an override.

**Restore defaults** on a phone removes its override and uses the computer default. On the computer, it removes the computer override and uses plugin configuration. Other device overrides are retained.

## Find a module

**Optional extensions** appear first. **DSH optional components (advanced)** and **Required for boot** are collapsed; required entries cannot be disabled. These groups aid browsing, not source verification, and one frontend module is not necessarily a complete plugin.

Search by name or module ID, or filter by **Load / Do not load**. Filtering retains unsaved choices outside the current results. Display names omit common DSH client prefixes and mechanically split package names; **Module details** contains the exact ID and declared dependencies without guessing a third-party plugin's purpose. Loading rules are collapsed until needed.

After a DSH or plugin update, an old exclusion may be missing from the catalog or required for boot. **Outdated selections** lists these entries separately. Explicitly remove an old exclusion and save to retain other choices. They are not cleared automatically, and required modules cannot be disabled.

## Choose and apply

1. Wait for the catalog. A failed or timed-out read has a **Reread settings** action; reopening the modal is unnecessary. Rereading replaces unsaved choices and asks for confirmation when changes exist.
2. Checked means load on the next open; unchecked means omit next time, not unload the current page. Required boot modules cannot be unchecked. Details show declared dependencies.
3. Review the unsaved-change count and select **Save selection**; saving stays disabled when nothing changed. A retained module depending on an excluded module is rejected with a conflict: keep the dependency or also exclude its unwanted consumer. Other modules are never unchecked automatically. If the catalog changed after the dialog read it (a plugin or version update), the save is refused with a reread prompt instead of overwriting the current state with a selection computed from the old catalog.
4. After a successful save, the current page, conversation, and draft are not reloaded automatically. Manually reopen or refresh the DSH page to apply the selection; saving through this control does not require a DSH restart.

Close, Escape and the App's Back action ask before discarding unsaved changes. A failed save keeps choices. A write timeout means the result is unconfirmed, not rolled back; reread to confirm. Writes are not retried automatically, and closing cannot undo a completed save. Long lists scroll independently while close and footer actions remain reachable.

Computer pages and `?frontend=stock` pages are unaffected. DSH or community-plugin updates can change the catalog and dependencies. When a saved selection prevents the mobile page from starting, the page offers “Load all modules for this device and retry”; it changes this device’s selection only when you click, without changing computer defaults, other devices or pairing authorization. Settings APIs still reject invalid selections and enforce required-module and dependency checks.

## Measure sizes and minimize loading

Only **Measure sizes** fetches module resources and calculates their individual gzip sizes. Ordinary reads, saves and resets do not wait for these probes. Measurement can be cancelled without replacing unsaved choices, saving or reloading the page. Each measurement has a five-second budget; completed results remain available and the rest stay unknown. Known results are cached for ten minutes and must be measured again after a DSH module-graph update.

Each group lists measured modules largest first and unknown sizes last. Totals always identify any selected modules with unknown sizes rather than presenting a partial result as complete. The mobile layout is measured from the actual Gateway layout file. Batch merging, browser caches, encoding negotiation and plugin versions affect actual transfers, so the numbers compare current modules rather than promise exact next-open downloads or fixed savings.

Modules whose package metadata is resolvable in the installation may also show the plugin's own `package.json` description: links removed, collapsed to one line, at most 200 characters. This is not an upstream endorsement. Unexported or unreadable metadata stays absent instead of guessing its purpose. **Required only (minimal load)** keeps required boot entries and their dependencies and marks other entries as not loaded. Its confirmation states how many modules and how much size this excludes. It edits the draft only; **Save selection** remains a separate action.

## Data and authorization

Selections are atomically stored in the computer's private DSH Mobile data directory, without copying conversation drafts. The catalog returns module IDs, required markers, dependencies, selections, and available sizes and package descriptions—not upstream download URLs, host file paths, or pairing credentials. A phone reads its own selection through the authenticated Gateway; changes and explicit measurements also require same-origin and CSRF checks.

Revoking a pairing removes that identity's module override. To stop a phone from operating the computer, revoke the device on the computer rather than disabling one client component.

Direct edits to the profile's advanced configuration still require a DSH restart. See [Third-party plugin compatibility](../README.en.md#third-party-plugin-compatibility) for examples and limits.
