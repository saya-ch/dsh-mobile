# Unified mobile composer toolbar

## Status: requires a coordinated DSH core change

This presenter consumes a proposed optional `conversation.input.toolbar` slot.
The slot is not shipped by this repository. Do not release the unified toolbar
as working on an unmodified DSH host until the core declaration, renderer props,
and control-row observer lifecycle are implemented and tested upstream.

When the slot is absent, the registration waits for it and the stock composer
continues to render. That fallback does **not** provide the unified plugin row.
Desktop hosts do not load the dedicated mobile layout. A wide dedicated mobile
viewport returns the supplied stock element, except that a live recording holds
its current layout until it finishes to avoid remounting the recorder.

## Core-owned contract

Declare the optional child on the existing composer entry:

```ts
'conversation.input.toolbar': { kind: 'single', scope: 'session-maybe' }
```

The original InputBar must remain the owner of handlers, draft/file state,
permission checks, session scope, and the activity callback. Render the slot
with the original toolbar as its fallback and these layout-only props:

| Prop | Meaning |
| --- | --- |
| `stock` | Original complete toolbar React element, with its original ref |
| `rowRef` | Original core control-row ref, attached to the horizontal bottom row |
| `rowClassName` | Original control-row class, including model-collapse CSS |
| `leading` | Original upload/file input/permission/plan grouping, excluding left plugins |
| `model` | Original model grouping, excluding right plugins |
| `actions` | Original send/stop/queue/steer button elements |
| `pluginsLeft` | Original authorized `conversation.input.left` outlet node |
| `pluginsRight` | Original authorized `conversation.input.right` outlet node |
| `activity` | Original activity wrapper/outlet, with the original `onActiveChange` |
| `activityActive` | Whether the core activity panel is expanded |

Construct the original elements once per core render. Recompose only the core's
own unmounted grouping elements; do not clone plugin components, relocate DOM,
redeclare the original child slots, or duplicate send/recording callbacks.
Pass the original hidden/disabled props through unchanged.

The core observer must bind to the *actual* horizontal leading/trailing row,
not the vertical presenter root. It must rebind when the row is replaced across
the wide/phone breakpoint. For example, use a stable callback ref and a layout
effect keyed by the resulting element, retaining the existing observer:

```tsx
const [controlRow, setControlRow] = useState<HTMLDivElement | null>(null)
const rowRef = useCallback((row: HTMLDivElement | null) => {
  setControlRow(row)
}, [])
useLayoutEffect(() => {
  if (controlRow === null) return
  return observeControlRow(controlRow)
}, [controlRow])
```

## Mobile ownership

- One shared upper horizontal scrollport contains left, right, and idle voice
  controls; upload/permission/model/actions stay in the fixed bottom row.
- Preserve natural switch dimensions rather than applying action-button sizes.
- Keep the activity subtree at the same React path when recording expands.
- Hold the current presentation while recording crosses the 720px breakpoint.
  At 721–899px the dedicated shell's closed 56px navigation rail requires an
  activity-frame left inset; at 900px the shell docks the rail and the inset ends.
- Do not apply intrinsic toolbar widths or compact button sizing to native
  dialogs/popovers/menu roots. Non-portaled custom popups still require review.
- Unwrap the new display-contents SlotOutlet before the native adapter marks
  the actual stock/dedicated row; otherwise stock sizing leaks into plugins.

## Verification and limitations

Repository checks: typecheck and the presenter/native/layout focused tests.
The presenter unit tests mock hooks: they establish composition and style
contracts, **not** mounted recording continuity or full SDK integration.

A local integration experiment used the real DSH slot renderer and original
AutoContinue, CodexConnect, and voice components with substituted candidate
module responses. It covered 320/390/430px, one shared horizontal scrollport,
no vertical or page overflow, 36x20 switches, fixed 44px single/dual actions,
upload/model menus and the original native task dialog. The task control's
unavailable response and dual-action flags were UI-only fixtures, not changes
to live user/session state. A browser-generated silent stream exercised the
original voice recorder and cancellation at 760px, unchanged mount counters,
899/900px inset boundary, and stock/mobile observer rebinding.

Those local integration scripts and runtime-specific archive patches are not
part of this portable repository change. Repeat the SDK integration checks
against the canonical upstream core implementation before release. Hardware
microphone permissions, provider transcription, Android touch gestures,
session changes, and administrative plugin unload remain acceptance checks;
do not infer them from the mocked tests or the silent-stream experiment.
