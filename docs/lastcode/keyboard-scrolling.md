# Keyboard Scrolling

LastCode makes ArrowUp, ArrowDown, PageUp and PageDown scroll the pane under
the mouse pointer. The owner scrolls with keys, often sent by mouse buttons,
instead of the wheel. Upstream sends these keys to the focused element only.
LastCode keeps upstream's model and adds one rule on top: **the pointer picks
the pane; focus decides what happens inside that pane.**

All of it lives in [`lastcodeScrollKeys.ts`](../../apps/web/src/lastcodeScrollKeys.ts),
started from `appInit.tsx`. Its browser test has one case per row of the table
below. Do not add a second key handler for a scrolling surface. Add a row to
the table, a case to the test, and a rule to the router instead. Earlier fixes
patched each surface separately (sidebar page keys, hover-card keys, pane
paging, timeline paging) and regressed one at a time as upstream moved.

## Desired behaviour

| Situation                                                                                                                                                                     | Result                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pointer over a scrollable pane (sidebar, conversation, details, settings, hover card), focus anywhere else                                                                    | Arrow and page keys scroll that pane. Focus does not move.                                                                                                                                                                                              |
| Pointer over the sidebar's resize rail, or over non-scrolling chrome inside a pane (the sidebar's search header, a settings header)                                           | Scrolls that pane's list.                                                                                                                                                                                                                               |
| Focus in the composer, pointer over its own conversation                                                                                                                      | Upstream behaviour: arrows move the caret or recall previous prompts, and page keys scroll the composer, then hand off to the conversation.                                                                                                             |
| Focus in any text field or keyboard widget (tabs, listbox, tree, a dialog's search field), pointer over that same pane. Each workspace area inside a dialog is its own pane   | The focused element keeps the keys.                                                                                                                                                                                                                     |
| A sidebar row has focus and the pointer is over the sidebar                                                                                                                   | After a click, the sidebar scrolls. After keyboard navigation (Tab, F6 or any other key, which parks the pointer), arrows move between rows as upstream does.                                                                                           |
| Focus in a text field, pointer over a different pane                                                                                                                          | The pane under the pointer scrolls.                                                                                                                                                                                                                     |
| Any key other than an unmodified scroll key or a bare modifier was pressed since the mouse last moved (Shift+Arrow and Cmd+Arrow are editing keys and count)                  | Arrow keys go to focus (typing parks the pointer, like macOS hiding the cursor). Page keys still follow the pointer. Esc is the usual way to hand arrows back to the composer.                                                                          |
| Focus in the terminal, a shortcut recorder, an open suggestion list (`aria-activedescendant`, expanded combobox), or an open menu or dialog that does not contain the pointer | Focus keeps the keys. Pointer over the terminal leaves keys alone.                                                                                                                                                                                      |
| A keybinding is bound to the key, or the key has a modifier                                                                                                                   | Untouched.                                                                                                                                                                                                                                              |
| The pane under the pointer is at its end, or its content fits                                                                                                                 | The key stops there; it never scrolls another pane. Nested scrollers chain outward like the wheel and stop at `overscroll-behavior: contain`. If focus is inside that pane, the focused element gets the key instead (row and settings-section arrows). |
| Focus is on the scroller under the pointer                                                                                                                                    | Native scrolling, except page keys in the conversation, which page the visible part above the composer (with the optional one-line overlap).                                                                                                            |
| No pointer known (window blurred, a touch or pen tap, pointer left the window), focus on a workspace region wrapper                                                           | The region's scroller scrolls (the conversation's timeline for the conversation region). The terminal region is left alone.                                                                                                                             |
| Scrolling the conversation from elsewhere                                                                                                                                     | Releases live follow, the same as scrolling it directly.                                                                                                                                                                                                |
| Focus inside an embedded frame (HTML previews, MCP apps)                                                                                                                      | Keys stay in the frame. The browser never delivers them to the app page, so the router cannot see them.                                                                                                                                                 |

The owner accepted upstream's ArrowUp prompt recall. An earlier LastCode wish,
ArrowUp scrolling the conversation once the composer caret reaches the top,
is not implemented because it would collide with recall. Do not add it unless
upstream drops recall.

## Upstream seams

The router depends on these upstream pieces. When a checkpoint changes one,
update the router and its test in the same repair, not the surface involved.

- Native focus scrolling, and the timeline scroller being focusable with
  `data-workspace-focus-default` (upstream #27209).
- `[data-workspace-area]` regions from `workspaceAreaProps`. The `composer`
  region counts as part of the nearest enclosing `conversation` region.
- The composer's page-key handoff (`getTimelinePageScrollKey` in
  `ComposerPromptEditorTiptap.tsx`) and ArrowUp prompt recall
  (`composerCommandKey.ts`).
- `hasCommandForKeyDown` in `shortcuts/dispatcher.ts`.
- The timeline's navigation signal. `timelineViewport.ts` registers the
  timeline as a scroll-key owner, so a scroll the router causes releases follow.
- Selectors: `[data-chat-composer-overlay]`, `[data-sidebar='rail']`,
  `[data-sidebar='content']`, `[data-slot='scroll-area-viewport']`,
  `[data-terminal-owner]`, and the floating-layer selectors in
  `composerFocusRedirect.ts`.

## When this fights upstream

Stop and tell the owner, rather than patching around it, when a checkpoint:

- adds pointer- or hover-based key routing of its own;
- gives arrow or page keys a new meaning in a pane, for example list navigation
  that takes arrows while the pointer is elsewhere;
- removes native focus scrolling from a surface, or moves keyboard scrolling to
  a custom controller; or
- changes composer ArrowUp or page-key behaviour.

In each case, name the upstream PR and the table rows it conflicts with.

## Checking after a checkpoint

Run the browser test beside the router. In the integrated QA pass, check:
pointer over the sidebar with the conversation focused (arrows and page keys
scroll the sidebar); composer focused with the pointer over the conversation
(arrows move the caret); composer focused with the pointer over the sidebar
(arrows scroll the sidebar); and ordinary wheel scrolling everywhere.
