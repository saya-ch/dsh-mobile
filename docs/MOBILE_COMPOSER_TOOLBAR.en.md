# Mobile composer layout

[简体中文](MOBILE_COMPOSER_TOOLBAR.md) · [Third-party compatibility](../README.en.md#third-party-plugin-compatibility)

> Compact, wrapping narrow-screen composer controls have been available since plugin 0.6.0; toolbar layout corrections since 0.6.3; and public-slot wrapper touch-target corrections since 0.6.4. Android and mobile browsers use the plugin-served page; these web changes do not require reinstalling the App.

The narrow-screen composer preserves DSH's native structure and handlers. Model names truncate when space is limited, additional controls wrap, and Send/Stop retain touch dimensions. Entire native groups wrap according to their actual width. Switches are not stretched into action buttons, and inline dialogs, menus and lists do not receive compact toolbar sizing.

## Layout and limits

Current DSH puts left and right extensions under different React parents, and its width observer measures those two native groups. It exposes no parent `conversation.input.toolbar` entry. The current implementation does not combine all plugins into a shared upper scrollport, move DOM, copy core callbacks or flatten the tree with `display:contents`.

Compact/overflow fixes use the available public slots. A future upstream parent-toolbar capability can be evaluated separately.

## Compact extension boundaries

The layout preserves native parent groups and adjusts wrapping, spacing and reachability. It does not guess third-party classes to hide labels, errors or task-recovery exits. Icons, quota summaries and compact preferences belong to the plugin providing the control; without a public compact interface, keep its existing presentation instead of adding an ineffective setting. Small visual icons still need reachable touch targets.

Public-slot checks also cover compact shapes representing an auto-continue switch, Fast icon, quota summary and existing-task recovery entry. These are presentation fixtures without service behavior, not evidence that a particular community plugin's interfaces, task operations or quota requests work.

On small screens, direct span/div wrappers with a non-switch button in the public left/right slots reserve room for the 44px target, preventing it from escaping the upstream slot wrapper into adjacent controls. The rule does not identify third-party classes; pure switches, popup wrappers and wrappers containing buttons only deeper in their trees are excluded, as are wide viewports.

## Display size and available space

When text is oversized or little reading space remains, first check **Settings → General → Mobile font size**. **More font settings** shows only the code size and text/code family controls actually supported by the current DSH theme. These web preferences are local to the current address, without changing the computer or other devices. They do not guarantee font changes in a terminal canvas or arbitrary third-party controls.

The Android App's **Settings → General → Page zoom** resizes the entire WebView independently of web font size; reset it to 100% when comparing defaults. It appears only when the App advertises the required native capability, not in mobile browsers or unsupported older Apps. See the [App manual](../apps/mobile/README.md#devices-and-settings) for its range and App requirements.

## Verification scope

The real DSH composer runs with test extensions genuinely registered through the public left/right/activity slots. Checks cover small viewports, landscape, larger text, both themes, model compactness, popups, switches and reachable Send/Stop. Editor, draft and active activity nodes remain mounted without a page reload.

The activity fixture verifies slot/mount continuity, not a physical microphone or recognition provider. Arbitrary community combinations can still have their own layout issues; [Mobile page modules](CLIENT_MODULES.en.md) can exclude unneeded optional modules.
