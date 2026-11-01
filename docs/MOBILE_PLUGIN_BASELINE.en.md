# Plugin mobile baseline

[中文](MOBILE_PLUGIN_BASELINE.md) · [Documentation index](README.md) · [Adaptation guide (how to)](MOBILE_PLUGIN_ADAPTATION.en.md)

This document gives a plugin-owned Web panel in a browser or WebView a baseline that can be accepted or rejected: three levels, the source of every number, a stylesheet to copy, and how to prove it holds. It answers "how good is good enough"; **how** to get there is in the [adaptation guide](MOBILE_PLUGIN_ADAPTATION.en.md), and this project's own visual numbers live in the [design reference](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md).

It is an **informative adaptation guide** and does not change the existing boundary: the mobile layer owns connectivity and page layout, it does not rearrange a third-party plugin's internal controls, and a panel's small-screen usability is the plugin author's responsibility. The levels are not a release gate; they exist for issue checklists, PR self-review, or an agreement between an author and their users. Missing a level is not a defect — per the [contributing guide](https://github.com/saya-ch/dsh-mobile/blob/main/CONTRIBUTING.md), a compatibility request is not a guarantee for every third-party combination. **This baseline is this project's adaptation guidance, not an official DSH standard, and does not represent the DSH team's position.**

## Three levels

| Level | Name | Requirement (must / should) | Typical evidence |
| --- | --- | --- | --- |
| L1 | Tappable | **Must**: main Web actions have a hit region of at least 44×44 CSS px (48px for a primary action where space allows); adjacent actions keep spacing; inputs and editable areas inherit at least 16px type; keyboard focus stays visible; no page-level horizontal overflow at 375px; collapsing width never hides the only entry point | Renders at 375px and 390px widths with hit-region measurements |
| L2 | Comfortable | **Should**: switch on the panel's **measured width** (600px or less suggested); horizontal chip/tab strips scroll sideways; inline text actions collapse to an icon with an accessible name; body text follows `--dsh-content-font-size`; edge-to-edge areas reserve `env(safe-area-inset-*)`; an independent scroll container sets `overscroll-behavior: contain`; forms collapse to one column in the narrow tier | The same panel in a narrow and a wide container |
| L3 | Regressible | **Should**: the static preview can render at a requested width; the structural assertions for L1/L2 are wired into the render check; the desktop render has a baseline to compare; device-only gaps are written down | Assertion output, screenshot baseline, PR notes |

L1 can be prechecked in a desktop browser at 390px; that does not cover a device's keyboard, text scaling or safe areas. L2 must be checked where the **panel width differs from the viewport width** (a narrow desktop column, a drawer). L3 pins the first two; it is not a new interaction requirement.

## Where the numbers come from

Web, iOS and Android use different units and scopes. Project recommendations do not replace platform or accessibility requirements, and pt, dp and CSS px must not be treated as equivalent.

| Requirement | Source | Note |
| --- | --- | --- |
| 44×44 CSS px hit region | This project's [design reference](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md) (Web targets ≥44px, 48px for primary actions); [Apple HIG · Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) (hit region of at least 44×44 pt); [WCAG 2.2 SC 2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) (AAA, 44×44 CSS px) | pt, dp and CSS px are three different units; nothing is converted here, only the magnitude is shared |
| 24×24 CSS px | [WCAG 2.2 SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) (AA, with a spacing exception) | A minimum, not a target; this project uses 44 |
| 48dp | [Android minimum interactive component size](https://developer.android.com/reference/kotlin/androidx/compose/material/minimumInteractiveComponentSize.modifier) | Native controls only; do not convert it into a CSS px value for a Web panel |
| Input type ≥16px | [Design reference](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md) (the mobile shell already enforces it); iOS zooms the page when a focused form control's font size is below 16px | Do not shrink inputs below that to make a layout fit |
| `env(safe-area-inset-*)` | [MDN · env()](https://developer.mozilla.org/en-US/docs/Web/CSS/env) | Requires `viewport-fit=cover`; add it only where the content really reaches the edge and the shell has not already handled it |
| `@container` | [MDN · Container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries) | Components lay out by container width; all major browsers have supported it since 2023, so keep a fluid fallback for older engines |
| `overscroll-behavior: contain` | [MDN · overscroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior) | Stops scroll chaining: reaching the panel's end must not drag the page behind it |
| `prefers-reduced-motion` | [MDN · prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) | Drop decorative animation; a loading indicator may stay |

### Two common misuses of 44px

- **A hit region is not a visual size.** A round checkbox may stay visually 24px and use an associated label for its full click target; enlarging the whole card is not adaptation.
- **Do not grow hit areas by covering neighbours.** Expanded regions must not overlap adjacent controls or change wrapping and focus order; use spacing, not overlap.

## A stylesheet to copy

Replace `plugin-panel` with your own root class. Enable `data-mobile="1"` only when the measured panel enters its narrow tier. Wide panels are unchanged; a narrow desktop column can also enable it. The switch itself (container query or measured width) is in the [adaptation guide](MOBILE_PLUGIN_ADAPTATION.en.md#adapt-to-available-space).

The attribute name is the plugin's own convention — the guide's script example uses `data-narrow`. The name does not matter; what matters is that the whole narrow tier hangs off **one** switch, and that wide panels omit it; the value names a width tier, not a device type.

```css
/* Type follows the shell setting; without the variable it stays inherited, so the desktop is unchanged. */
.plugin-panel[data-mobile="1"] { font-size: var(--dsh-content-font-size, inherit); }

/* Apply these classes to ordinary actions/text fields, not native switches or ranges. Layout boxes change. */
.plugin-panel[data-mobile="1"] :is(.action, .icon-button, .primary-action, .text-input, select) { min-width: 44px; min-height: 44px; }
.plugin-panel[data-mobile="1"] .icon-button { min-width: 44px; }
.plugin-panel[data-mobile="1"] .primary-action { min-height: 48px; }

/* Use <label class="check-label"><input type="checkbox">Name</label>, without covering adjacent controls. */
.plugin-panel[data-mobile="1"] .check-label { display: inline-flex; align-items: center; gap: 8px; min-width: 44px; min-height: 44px; padding: 10px; box-sizing: border-box; }
.plugin-panel[data-mobile="1"] .check-label input { width: 24px; height: 24px; margin: 0; }

/* Horizontal chip strips scroll sideways; a 1px divider would hang alone in a scrolling row. */
.plugin-panel[data-mobile="1"] .chips { display: flex; flex-wrap: nowrap; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
.plugin-panel[data-mobile="1"] .chips::-webkit-scrollbar { display: none; }
.plugin-panel[data-mobile="1"] .chip { flex: 0 0 auto; min-height: 44px; }
.plugin-panel[data-mobile="1"] .chips .divider { display: none; }

/* Inline text actions collapse to icons; the text stays in the menu or detail view, and the accessible name must stay. */
.plugin-panel[data-mobile="1"] .action-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.plugin-panel[data-mobile="1"] .row-action { min-width: 44px; padding: 0; justify-content: center; }

/* Hide only repeated decorative shortcuts, not the sole operating instructions. */
.plugin-panel[data-mobile="1"] .kbd { display: none; }

/* Edge-to-edge areas reserve the safe area; the panel's own scroll container stops chaining. */
.plugin-panel[data-mobile="1"] .content { padding-bottom: max(28px, calc(14px + env(safe-area-inset-bottom))); }
.plugin-panel[data-mobile="1"] .scroll-body { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }

/* Forms collapse to one column; a multi-line input keeps a usable height. */
.plugin-panel[data-mobile="1"] .form-row { grid-template-columns: minmax(0, 1fr); }
.plugin-panel[data-mobile="1"] textarea { min-height: 96px; }

/* Collapse decorative/repeated copy only, never essential operating instructions. */
.plugin-panel[data-mobile="1"] .title { font-size: 1.2em; line-height: 1.4; }
.plugin-panel[data-mobile="1"] .subtitle { display: none; }

@media (prefers-reduced-motion: reduce) {
  .plugin-panel[data-mobile="1"] .chips { scroll-behavior: auto; }
}
```

## How to prove it

| Level | Evidence | Note |
| --- | --- | --- |
| L1 | A 390×844 render plus hit-region measurements | Measure the layout box, not the CSS declaration; a `min-height` can still be compressed, clipped or covered |
| L2 | One render in a narrow container and one in a wide container | The narrow container means a ≤600px panel, not a shrunken viewport — that is exactly what the measured width or container query is for |
| L3 | Structural assertions + a desktop baseline | Assert at least: the narrow marker appears, the 44px rule exists, the safe-area and type rules exist, every narrow rule is scoped to the same switch, and collapsed actions keep an accessible name; compare the desktop baseline in a fixed browser/font/viewport environment and explain expected differences; string-presence assertions do not replace geometry or interaction checks |

Static checks establish only the declarations they inspect. Geometry and hit testing need a browser, and the following additionally need device evidence with explicit coverage:

- the visible area and focus scrolling after the soft keyboard opens;
- the real `env(safe-area-inset-*)` values;
- momentum scrolling and rebound;
- wrapping and truncation at a larger system font size.

## How this sits with the other documents

| Document | Question it answers |
| --- | --- |
| [Adaptation guide](MOBILE_PLUGIN_ADAPTATION.en.md) | How: host behavior, example code, item-by-item technique, overlay layering |
| This document | What counts as done: levels, number provenance, baseline stylesheet, acceptance evidence |
| [Design reference](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md) | This project's visual and numeric rules (color, type, radius, hit region) |
| [Contributing guide](https://github.com/saya-ch/dsh-mobile/blob/main/CONTRIBUTING.md) | How to submit, which checks to run, the boundary of compatibility requests |

## Boundaries

- It covers plugin-owned Web panels only; background services and plugins that depend on native windows are out of scope.
- It does not ask for a redesign and does not justify a second component tree per platform; lists and details should stay one implementation.
- The mobile layer must not inject third-party CSS by class name: a renamed class breaks the rule and the desktop at the same time.
- Do not use a user agent or `pointer: coarse` alone instead of a measured width; hybrid input (touch laptops, tablets with a mouse) makes both signals wrong.
