# DSH Mobile design system

## Direction

This is an internal design reference, not a promise that DSH Mobile replaces the host UI. Plugin-owned controls follow DSH's current theme; native connection screens follow Android light/dark mode and place readable cards over the bundled character artwork. Keep controls calm and functional. Avoid decorative gradients, glow, glass effects, particles, animated ambient backgrounds, or emoji icons in product controls; the existing brand illustration is separate from these controls.

## Color

The native colors below mirror `apps/mobile/android/app/src/main/res/values[-night]/colors.xml`; use DSH semantic tokens instead for WebView controls.

| Native role | Light | Dark |
| --- | --- | --- |
| Background | `#F7F8FA` | `#0F172A` |
| Card surface | `#FFFFFF` | `#1E293B` |
| Primary text | `#111827` | `#F8FAFC` |
| Secondary text | `#667085` | `#CBD5E1` |
| Accent | `#2563EB` | `#60A5FA` |
| Border | `#E4E7EC` | `#475569` |
| Error | `#B91C1C` | `#FCA5A5` |

Maintain at least 4.5:1 text contrast over cards and artwork scrims. Native screens follow Android's theme; the WebView follows DSH's theme. Plugin surfaces must not force a global theme.

## Typography

In WebView controls, inherit DSH's system font stack. Use 16px inputs on mobile to avoid browser zoom and preserve user font scaling. The existing repository hero asset includes its own brand title; do not overlay a duplicate title.

## Shape and depth

- Card radius: 16px.
- Button radius: 12px.
- Touch target: at least 44px; prefer 48px for primary mobile actions.
- Use a subtle theme-aware border and restrained shadows.
- Never shift layout on hover or press.

## Motion

Use only short 150-200ms state transitions. Respect `prefers-reduced-motion`; no decorative entrance animation or continuous animation.

## Mobile layout

- Honor safe-area insets on every edge.
- Keep conversation content full-width on narrow screens.
- Prevent page-level horizontal overflow. Wide tables and code blocks may scroll inside their own containers.
- Keep primary actions reachable above the soft keyboard.
- Test 375px and 390px portrait, landscape, font scaling, and keyboard-open states.

## Brand artwork

- App icon: use `assets/brand/app-icon-master.png` as the source; it shows a blue-haired whale-themed character holding a phone. Do not replace it with an unrelated mark or add text/watermarks to the icon.
- Repository hero: use `assets/brand/repository-hero.png`; the existing image includes the DSH Mobile title at left and a character with a desktop scene at right. Keep README copy outside the image rather than duplicating its built-in title.

## Delivery checklist

- [ ] Native light/dark colors or DSH semantic tokens, with readable artwork scrims.
- [ ] No emoji icons, gradients, glow, particles, or glass effects.
- [ ] Visible keyboard focus.
- [ ] 44px minimum touch targets.
- [ ] Safe-area and soft-keyboard handling.
- [ ] Reduced motion supported.
- [ ] No content hidden behind fixed controls.
- [ ] No page-level horizontal overflow at 375px; wide content scrolls only inside its container.
