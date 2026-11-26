---
area: in-a-thread
title: Working inside a thread
tier: prefer-ours
paths:
  - apps/web/src/lastcodeScrollKeys.ts
  - docs/lastcode/keyboard-scrolling.md
  - apps/server/src/promptSnippets/
  - apps/web/src/lastcodeComposerSourceEdits.ts
  - apps/web/src/lastcodeComposerSourceHooks.ts
  - apps/web/src/lastcodeComposerSourceShortcuts.ts
  - apps/web/src/lastcodeComposerSourceSlice.ts
  - apps/web/src/components/ComposerPromptEditorTiptap.tsx
  - apps/web/src/components/chat/ChatComposer.tsx
  - apps/server/src/terminal/
---

# Working inside a thread

## Purpose

The owner spends the day reading, writing and steering inside threads, mostly from the keyboard. This area keeps that fast: keys scroll what the pointer is over, prompts the owner sends often are a keystroke away, and the composer and terminal never lose or misplace what was typed.

## Intents

### Composer and prompt snippets

- Common prompts are learned from the owner's own conversations and can be inserted, searched, edited, added, dismissed and restored, on web, desktop and mobile.
- The composer can switch between formatted and source editing without losing the draft, the selection, context chips or undo history.
- Typing at the edge of formatting, such as bold or code, adds plain text where the caret is.

### Keyboard scrolling and focus

- Arrow and page keys scroll the pane under the pointer, while focus decides what happens inside a pane, as set out in `docs/lastcode/keyboard-scrolling.md`.
- Upstream's ArrowUp prompt recall stays. When upstream changes how these keys behave, the owner decides, as that document describes.

### Terminal

- Input waits until the terminal's shell has started, so nothing typed early is lost.
- Closing a thread stops its terminals, and a stopped terminal never comes back.

### Provider adjustments

- No intents of its own. Adapter changes that serve delegation, waiting or the background browser take the tier of **Agents directing agents** or **Seeing what agents build**. Fixes to upstream adapter behaviour follow lean upstream.
