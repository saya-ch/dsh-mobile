# Mobile composer layout

[简体中文](MOBILE_COMPOSER_TOOLBAR.md) · [Third-party compatibility](../README.en.md#third-party-plugin-compatibility)

> Layout changes in plugin 0.6.3. Android and mobile browsers use the same plugin-served page; this change does not require reinstalling the App.

The narrow-screen composer preserves DSH's native structure and handlers. Model names truncate when space is limited, additional controls wrap, and Send/Stop retain touch dimensions. Entire native groups wrap according to their actual width. Switches are not stretched into action buttons, and inline dialogs, menus and lists do not receive compact toolbar sizing.

## Difference from the original PR

The original proposal combined plugins into one upper horizontal scrollport with native actions fixed below. Current DSH exposes no parent `conversation.input.toolbar` entry; left and right plugins belong to different React parents, and the core width observer measures those two native groups. This version does not provide a shared upper scrollport, move DOM, copy core callbacks or flatten the tree with `display:contents`.

It implements compact/overflow fixes through available public seams, retaining the original author commit with maintainer corrections. A future upstream parent-toolbar capability can be evaluated separately rather than registering a presenter that never renders.

## Verification scope

The real DSH composer runs with test extensions genuinely registered through the public left/right/activity slots. Checks cover small viewports, landscape, larger text, both themes, model compactness, popups, switches and reachable Send/Stop. Editor, draft and active activity nodes remain mounted without a page reload.

The activity fixture verifies slot/mount continuity, not a physical microphone or recognition provider. Arbitrary community combinations can still have their own layout issues; [Mobile page modules](CLIENT_MODULES.en.md) can exclude unneeded optional modules.
