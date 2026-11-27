# DSH Mobile design system

## Direction

This is an internal design reference, not a promise that DSH Mobile replaces the host UI. Plugin-owned controls follow DSH's current theme; native connection screens follow Android light/dark mode and place readable cards over the bundled character artwork. Keep controls calm and functional. Avoid decorative gradients, glow, glass effects, particles, animated ambient backgrounds, or emoji icons in product controls; the existing brand illustration is separate from these controls.

## Color

The native colors below mirror the [light](../../apps/mobile/android/app/src/main/res/values/colors.xml) and [dark](../../apps/mobile/android/app/src/main/res/values-night/colors.xml) resources; use DSH semantic tokens instead for WebView controls.

| Native role | Light | Dark |
| --- | --- | --- |
| Background (`app_background`) | `#F3F6FC` | `#0A1020` |
| Card surface (`app_card_fill`) | `#FFFFFF` | `#16203A` |
| Primary text (`app_foreground`) | `#0F172A` | `#F1F5F9` |
| Secondary text (`app_secondary`) | `#52607A` | `#8FA3C4` |
| Accent (`app_accent`) | `#2563EB` | `#60A5FA` |
| Text on primary button (`app_button_text`) | `#1D4ED8` | `#BFDBFE` |
| Border (`app_border`) | `#E3EAF5` | `#29FFFFFF` (16% white) |
| Error (`app_error`) | `#C81E1E` | `#F87171` |

The values are the literal entries in those two resources. The card fill is `app_card_fill`: `app_surface` is a translucent wash (`#14FFFFFF` in dark), so it is not the card colour. Sheets use `app_dialog_surface` (`#FFFFFF` / `#1E293B`) and row dividers use `app_divider` (`#D8E2F1` / `#2A3A55`). Error has separate entries: `app_error_container` is the inline failure banner fill (`#FEF2F2` / `#2C1618`), while the destructive button paints `app_danger_fill` (`#C81E1E` / `#B91C1C`) with `app_danger_text` (`#FFFFFF` in both themes). The primary button is a three-stop gradient (`app_button_*`), and its label uses `app_button_text`, contrast-checked against every stop.

Maintain at least 4.5:1 text contrast over cards and artwork scrims. Native screens follow Android's theme; the WebView follows DSH's theme. Plugin surfaces must not force a global theme.

### Windows desktop surface scale

The portable Windows client (`apps/windows/`) keeps the roles above but derives its own surface steps, because a 1600px-wide desktop page is read differently from a phone card stacked over artwork. It does **not** mirror the Android values one-to-one:

| Role | Light | Dark |
| --- | --- | --- |
| Page canvas | `#F5F5F7` | `#0A101E` |
| Navigation rail | `#FDFDFF` | `#080D18` (below the canvas) |
| Group card | `#FFFFFF` | `#151E2E` (above the canvas) |
| Card border | `#E8ECF2` | `#24314A` (hairline, not a frame) |
| Row divider | `#EDF0F4` | `#232F45` (fainter than the card border) |
| Accent tint (selection, brand band) | `#E9EFFD` | `#17263F` |
| Secondary text | `#667085` | `#A9B6CB` |
| Muted text (eyebrow, footer) | `#5F6A7A` | `#8A97AC` |

The card border and the row divider are deliberately different weights. The border is a hairline that closes the card without drawing a frame around it; the divider is fainter still, because a row separator inside a card should be felt rather than seen. Grouping is carried by the canvas step (`#F5F5F7` to `#FFFFFF`), not by outlines — this is the same choice Apple's settings panels make, and it is why the border went from `#C6CCD6` to `#E8ECF2`. Do not "restore" contrast by darkening it: if a card needs to separate, raise its shadow, not its outline.

The dark column is deliberately **not** the Android dark background, card and border (`#0A1020 / #16203A / #29FFFFFF`): at desktop width those three read as one flat blue, and the 16% white border reads brighter than the surface it frames. Keep the three-level order rail < canvas < card, keep borders low-saturation, and keep the shadow soft — depth on dark comes from the border and the rail step, not from a halo.

Two consequences follow from that order. A raised or floating layer takes one more step above the card (`#1A2436` dark) instead of reusing the card fill or adding a highlight. And the dark shadow must be neutral black at a lower offset: the light theme's navy-tinted shadow (`#0B1220`) lands on a dark canvas as a blue halo, which is the glow this document forbids, and a shadow brighter than the gap it separates reads as a defect rather than elevation.

`MutedTextBrush` is the smallest text in the shell (10.5px uppercase eyebrow, footer metadata). It must stay at **≥5:1** against both the canvas and the card in each theme; `#98A2B3` failed at 2.5:1 and was replaced. `SuccessBrush`/`WarningBrush` exist for connection-state chips (`#15803D`/`#4ADE80`, `#B45309`/`#FBBF24`).

## Typography

In WebView controls, inherit DSH's system font stack. Use at least 16 CSS pixels for mobile inputs to avoid focus zoom while preserving larger user font preferences. The existing repository hero asset includes its own brand title; do not overlay a duplicate title.

Keep per-Origin mobile font preferences separate from App-wide WebView zoom. Show advanced typography only when the theme consumes its public tokens; a terminal canvas needs its own supported font control. Native text uses scaled text units (`sp`), while native geometry uses `dp`; neither is a raw device pixel.

## Shape and depth

- Native card radius: 16–20dp according to the existing screen.
- Native button radius: 12dp for secondary actions and 16dp for primary actions; preserve existing component variants.
- Windows desktop row height is 76 DIP with 20 DIP insets, page gutters are 40 DIP, and the settings
  page display title is 34 DIP — the larger title and the wider gutters are what give the shell its
  calm, Apple-like reading rhythm. Row title 14 DIP semibold against a 12.5 DIP muted hint.
- Windows desktop uses device-independent pixels, not dp, and the portable client sits closer to the eye on a large display. Its scale is one step tighter: group cards 14, secondary buttons 9, primary buttons 10, icon chips 10, segmented pills 7. Do not carry the 16–20 card value to Windows: a 20-radius card at 1000px column width reads as a bubble.
- Those Windows values are DIPs at the user's own scale factor, not device pixels: the same layout is 2560 physical pixels wide on a 1280-DIP screen at 200%. Judge a desktop review in DIPs (physical pixels ÷ the display scale) on a maximized window; a screenshot's pixel width is not the layout's width.
- Native touch target: at least 48dp. Web targets: at least 44 CSS pixels, with 48px for primary mobile actions where space permits. The Windows rail uses 60×54 DIP destinations for the same reason; a 40×40 icon button was too small even with a mouse.
- Use a subtle theme-aware border and restrained shadows.
- Never shift layout on hover or press.

## Motion

Use short 150–240ms state/navigation transitions. Respect `prefers-reduced-motion`; avoid decorative entrance or ambient animation. A loading indicator may run while an operation is pending, with a visible cancellation action for connection waits. Reveal a painted webpage without keeping the full-screen artwork above its progress; keep the smaller cancellation action until it becomes usable.

## Mobile layout

- Honor safe-area insets on every edge.
- Keep conversation content full-width on narrow screens.
- Prevent page-level horizontal overflow. Wide tables and code blocks may scroll inside their own containers.
- Keep primary actions reachable above the soft keyboard.
- Test 375px and 390px portrait, landscape, font scaling, and keyboard-open states.
- Plugin-owned panels follow the [plugin mobile baseline](../../docs/MOBILE_PLUGIN_BASELINE.en.md) for hit regions, type and the evidence expected in a PR.

## Brand artwork

- Default app artwork: `assets/brand/app-icon-master.png` shows the whale-themed character holding a phone. Keep this as the default identity and README icon; do not add text or watermarks. The app also offers six existing DeepSeek whale-mark color variants through native Launcher aliases. Selecting one changes only the launcher artwork, not the package, signer or paired data; it does not make this community app an official DeepSeek client.
- Repository hero: use `assets/brand/repository-hero.png`; the existing image includes the DSH Mobile title at left and a character with a desktop scene at right. Keep README copy outside the image rather than duplicating its built-in title.

## Delivery checklist

- [ ] Native light/dark colors or DSH semantic tokens, with readable artwork scrims.
- [ ] No emoji icons, gradients, glow, particles, or glass effects.
- [ ] Visible keyboard focus.
- [ ] Native targets at least 48dp; Web targets at least 44 CSS pixels; Windows rail destinations at least 60×54 DIP.
- [ ] Desktop shell reviewed in a DPI-aware maximized window at its DIP size, using the Windows surface scale rather than the Android table.
- [ ] Safe-area and soft-keyboard handling.
- [ ] Reduced motion supported.
- [ ] No content hidden behind fixed controls.
- [ ] No page-level horizontal overflow at 375px; wide content scrolls only inside its container.
