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

| Situation                                                                                                                                                      | Result                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Pointer over a scrollable pane (sidebar, conversation, details, settings, hover card), focus anywhere else                                                     | Arrow and page keys scroll that pane. Focus does not move.                                                                                   |
| Pointer over the sidebar's resize rail                                                                                                                         | Scrolls the sidebar.                                                                                                                         |
| Focus in the composer, pointer over its own conversation                                                                                                       | Upstream behaviour: arrows move the caret or recall previous prompts, and page keys scroll the composer, then hand off to the conversation.  |
| Focus in any text field or keyboard widget (tabs, listbox, tree), pointer over that same pane                                                                  | The focused element keeps the keys.                                                                                                          |
| Focus in a text field, pointer over a different pane                                                                                                           | The pane under the pointer scrolls.                                                                                                          |
| Any key other than a scroll key or a bare modifier was pressed since the mouse last moved                                                                      | Arrow keys go to focus (typing parks the pointer, like macOS hiding the cursor). Page keys still follow the pointer.                         |
| Focus in the terminal, in an open suggestion list (`aria-activedescendant`, expanded combobox), or in an open menu or dialog that does not contain the pointer | Focus keeps the keys. Pointer over the terminal leaves keys alone.                                                                           |
| A keybinding is bound to the key, or the key has a modifier                                                                                                    | Untouched.                                                                                                                                   |
| The pane under the pointer is at its end                                                                                                                       | The key stops there; it never scrolls another pane. Nested scrollers chain outward like the wheel.                                           |
| Focus is on the scroller under the pointer                                                                                                                     | Native scrolling, except page keys in the conversation, which page the visible part above the composer (with the optional one-line overlap). |
| No pointer known (window blurred, touch, pointer left the window), focus on a workspace region wrapper                                                         | The region's scroller scrolls (the conversation's timeline for the conversation region).                                                     |
| Scrolling the conversation from elsewhere                                                                                                                      | Releases live follow, the same as scrolling it directly.                                                                                     |

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
