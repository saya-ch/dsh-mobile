# Mobile plugin adaptation guide

[中文](MOBILE_PLUGIN_ADAPTATION.md) · [Documentation index](README.md)

> The acceptance levels and where the numbers come from are in the [plugin mobile baseline](MOBILE_PLUGIN_BASELINE.en.md); this guide covers the techniques.

This guide is for DSH plugin authors, aiming for **usable small screens without desktop regressions**. DSH Mobile provides connectivity, page layout and shared entry points; it does not rearrange every third-party plugin's internal controls. Start in a browser, then add device acceptance; an Android device is not required to begin.

## Identify where the panel is mounted

| Current mobile-page behavior | What the plugin should do |
| --- | --- |
| Opening a panel in the `main` slot adds a “Back to conversation” bar above it | Use the container's actual available height. The bar is at least 56px high; safe areas and content can increase it. Do not subtract a fixed 56px from screen height |
| The narrow sidebar is a drawer no wider than `min(88vw, 340px)`; a wide layout can keep it persistent | Do not assume a fixed 340px sidebar. Let entry labels and buttons shrink |
| The mobile layout has `.dshm-shell`, `[data-pane="conversation"]` and `[data-pane="sidebar"]` markers | Use these to locate regions while diagnosing. Scope internal styles to the plugin's own root rather than private host CSS class names |
| The mobile shell gives inputs and editable areas a 16px font floor while retaining larger inherited sizes | Leave room for editing, rather than counteracting user preferences with a smaller fixed font |
| Adapted shared entry points do not guarantee arbitrary third-party hit areas | Plugin authors must still check buttons, close actions, checkboxes and menus for actual hit testing |

These describe the current layout, not fixed dimensions a plugin should copy. Overlays, sidebars and main panels have different available space; verify the actual mounting location.

## Adapt to available space

Make the base layout shrink first: give flex/grid children `min-width: 0`, let toolbars wrap, and use content-driven height. Panel width is not always viewport width: a 400px panel in a desktop sidebar needs compact layout too.

For arrangement-only changes, CSS container queries are an option; full-page viewport adaptation can still use media queries. The `600px` below is an example breakpoint, to be chosen for the plugin's content:

```css
.plugin-panel-host { container-type: inline-size; min-width: 0; }
.plugin-panel { min-width: 0; }
.plugin-panel .toolbar { display: flex; flex-wrap: wrap; gap: 8px; }

@container (max-width: 600px) {
  .plugin-panel .toolbar { display: grid; grid-template-columns: minmax(0, 1fr); }
}
```

Wrap `.plugin-panel` in `.plugin-panel-host`. On engines without container queries, the base wrapping and fluid widths should remain usable; do not put an essential action solely in the query branch.

When a script branch is necessary, observe the component's root width instead of classifying a phone by user agent:

```js
const rootRef = useRef(null)
const [panelWidth, setPanelWidth] = useState(null)
const isNarrow = panelWidth !== null && panelWidth <= 600

useEffect(() => {
  const element = rootRef.current
  if (element === null) return undefined
  const measure = () => setPanelWidth(element.getBoundingClientRect().width)
  measure()
  window.addEventListener('resize', measure)
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
  observer?.observe(element)
  return () => {
    window.removeEventListener('resize', measure)
    observer?.disconnect()
  }
}, [])

// The component's returned root; keep a usable base layout before the first measurement.
h('section', { ref: rootRef, className: 'plugin-panel', 'data-narrow': isNarrow ? 'true' : 'false' }, contents)
```

Without ResizeObserver, this fallback only measures again on window resize. If a panel resizes independently, also use the plugin's existing layout notifications. Dispose observers and listeners when the component unmounts.

## Adaptation checklist

### Touch targets and spacing

This project recommends at least a **44×44 CSS px** hit area for primary Web controls, with 48px for primary actions where space permits; these are not conversions from Android dp or iOS pt. Leave space between adjacent actions rather than extending targets over their neighbors.

```css
.plugin-panel :is(button, select, input:not([type="checkbox"]):not([type="radio"])) { min-height: 44px; }
.plugin-panel .icon-button { min-width: 44px; }
.plugin-panel .actions { display: flex; flex-wrap: wrap; gap: 8px; }
.plugin-panel .check-label { box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px; min-width: 44px; min-height: 44px; padding-inline: 8px; }
```

Put a small checkbox inside its associated `label` to enlarge the clickable label without enlarging the icon. Use actual taps and `elementFromPoint()` to check edge hits; a declared `min-height` can still be shrunk, clipped or obscured by layout.

### Filters, tabs and inline actions

Long filter strips can wrap or use their own horizontally scrollable container; do not make the whole page overflow horizontally. Retain visible focus and enough padding to bring the last item fully into view:

```css
.plugin-panel .chips { display: flex; gap: 8px; overflow-x: auto; padding: 4px; }
.plugin-panel .chip { flex: 0 0 auto; min-height: 44px; }
```

An unambiguous inline action can become an icon on narrow panels, provided it keeps an accessible name and, where needed, a text explanation in a menu. Hover text cannot be the only explanation on a phone.

```js
h('button', { className: 'icon-button', 'aria-label': label }, h(Icon, { 'aria-hidden': true, name: 'play' }))
```

A narrow panel does not imply the absence of a keyboard. Decorative shortcut badges can collapse, but retain functioning shortcuts, help, Tab order and visible focus; do not remove keyboard-accessible behavior solely by width.

### Type, density and complete information

Inherit DSH's fonts and semantic colors. To follow the mobile page's text setting, a plugin can use `--dsh-content-font-size` on its content root and retain inheritance when the variable is absent:

```css
.plugin-panel { font-size: var(--dsh-content-font-size, inherit); line-height: 1.5; }
.plugin-panel .meta { color: var(--dsw-alias-label-secondary, currentColor); }
```

Compress decorative headings and whitespace, not touch targets. Let long titles wrap or offer an accessible way to view them in full. Errors, pending confirmations and essential action names must not exist only as truncated text. Check larger text, long paths and Chinese/English content.

### Overlays, forms and scrolling

Constrain overlays to their actual container and visible area, rather than using fixed dimensions that push actions off-screen. Reuse DSH's existing overlay components first; a custom overlay needs an accessible close action, focus management and Escape behavior.

```css
.plugin-panel .form-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.plugin-panel .scroll-body { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.plugin-panel textarea { box-sizing: border-box; width: 100%; min-height: 96px; }
```

Add `env(safe-area-inset-*)` only where content really reaches a screen edge and the host has not already handled it, avoiding duplicate space. Save, Cancel and errors must remain visible or reachable by scrolling with the keyboard open. An independent scroll area should not move the page underneath.

### Overlay layering and portals

The dedicated mobile shell uses `isolation:isolate` so its drawer and panels share a local stacking context. A positioned menu portalled directly to `document.body` with a positive `z-index` can paint above that shell; its value does not have to exceed the drawer's internal value. The stock-layout adapter retains its existing layer values.

This is not a guarantee that every body child outranks every dialog. Negative values, zero/auto paint order, ancestor stacking contexts, and the browser's top layer affect the result. Menus inside the shell remain constrained by their ancestors. Prefer the host's overlay facilities where available, and dismiss a menu when its owning panel closes or a modal takes focus. Do not globally raise third-party widgets or change DSH's dialog layers.

Verify actual visibility, focus and `document.elementFromPoint()` while the drawer, detail panel and settings are open, in narrow and wide layouts. The owned `smoke:plugin-portal-layers` fixture checks positive-z-index body menus and a top-layer dialog; it is not acceptance of every community plugin.

## Host-provided touch floor

When a third-party panel is open in the main slot, the mobile layer provides three safety measures:

- on a coarse pointer, ordinary buttons, selects and text inputs get **44×44 CSS px minimum layout boxes**. This changes visual geometry; it is not an invisible hit-area extension. Switches, checkboxes and ranges keep their own geometry, and the panel owns multiline inputs. The built-in plugin-manager page's cards open through a title button whose overlay already owns the whole card hit area, so those title buttons keep their compact size instead of being floored;
- a panel root that is `width:100vw` or a fixed pixel width is capped to the available width instead of overflowing;
- the panel content can scroll and contain the gesture without also making the outer main pane a second scroll container; the plugin's own scroll container remains the first choice.

This is a **floor, not a substitute for adapting the plugin**. A panel that ships its own touch geometry opts out on its root:

```html
<main data-dsh-adapt="off">…</main>
```

Root opt-out also disables the sizing and outer-scroll overrides; nested groups can use the attribute to retain their own control sizes. These rules apply only to coarse pointers and leave fine-pointer geometry and scrolling unchanged. Plugin authors still own responsive adaptation; this is not a compatibility guarantee for arbitrary plugin combinations.

## Verification: what code checks, browsers and devices establish

### Structural checks

Unit tests can check narrow branches, accessible names, retained state and unmount cleanup. Server rendering does not run browser layout measurement; supplying a test width or layout stub only establishes the chosen branch, not actual dimensions, hit testing or pixel-identical desktop output. A `44px` string in CSS is not touch acceptance.

### Real browser checks

Mount the plugin in an actual DSH page and cover at least 375px and 390px narrow viewports, landscape, full-width desktop and a narrow desktop sidebar. If a static preview is maintained, load it in a browser too and describe its differences from the real host.

- Cover list, detail, settings, empty, long-content and error states;
- Inspect element bounds, clipping ancestors and actual hit targets, including the first and last actions;
- Use a keyboard to check Tab, Escape and focus restoration, with no accidental background action while an overlay is open;
- Change width and text size, checking that drafts, selections and expanded state survive;
- Check light/dark themes and desktop baselines. Explain screenshot changes rather than demanding pixel identity for intentional improvements.

For example, after opening the real panel through its existing entry point, Playwright can check a control's geometry and hit testing. Replace the following selector with the plugin's own stable marker:

```js
const action = page.locator('[data-plugin-action="save"]')
await action.scrollIntoViewIfNeeded()
const box = await action.boundingBox()
if (box === null || box.width < 44 || box.height < 44) throw new Error('Save target is too small')
const hit = await action.evaluate(element => {
  const box = element.getBoundingClientRect()
  return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
})
if (!hit) throw new Error('Save target is obscured')
```

A center hit is a starting point, not a substitute for edge taps, scrolling, focus or state checks. See [CONTRIBUTING](../CONTRIBUTING.md#select-behavior-checks) for launch and verification procedures.

### Device follow-up

Browser emulation does not replace real WebView, keyboard, safe-area, momentum-scroll or external-keyboard acceptance. Record the device, App/WebView versions, connection and actual steps. State unverified parts directly instead of claiming all-platform success.

## Templates for plugin authors

### Issue

```markdown
## Plugin on a small screen
- Plugin name and version:
- DSH, DSH Mobile and App/browser versions:
- Panel location and available width (main / sidebar / overlay):
- Reproduction steps, expected and actual behavior:
- Screenshot and identifiable control (redact credentials and private content):
- Comparison with other optional frontend modules omitted, if tested:

## Acceptance goals
- [ ] Essential actions are visible and usable; long content is not clipped
- [ ] Actual touch areas, adjacent spacing and first/last items checked
- [ ] Keyboard focus, back/close behavior and drafts retained
- [ ] Overlays and forms work at narrow widths and larger text
- [ ] No desktop workflow regressions; unverified device behavior identified
```

### PR

- [ ] Describe affected entry points and content, without hard-splitting phone/desktop by UA;
- [ ] Reuse components and state; avoid duplicating business logic when arrangements differ;
- [ ] Supply real-browser narrow and desktop comparisons, steps and relevant tests;
- [ ] Check focus, hit testing, long content, errors and cleanup, not only CSS text;
- [ ] Distinguish verified and unverified device behavior; do not copy another version's results.

## Scope

This guide draws on community plugin adaptation and [discussion #279](https://github.com/saya-ch/dsh-mobile/discussions/279). It offers reusable implementation and acceptance ideas, not an independent verification of a new third-party release. For theme-specific questions, see [Skins and mobile layout](SKIN_COMPATIBILITY.en.md).

DSH Mobile does not maintain a universal override table keyed by third-party private class names, or guarantee that plugins requiring native windows work directly on remote pages. The plugin owning the component should maintain its adaptation through DSH's public extension points. Report missing host capabilities separately rather than modifying installed DSH artifacts to work around them.
