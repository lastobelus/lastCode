# Messages and context

Use the composer to send prompts, attach files, reference threads or pull requests, invoke skills, and steer or queue follow-ups.

## Limits and large pastes

- **Message length**: Up to 120,000 characters.
- **Large pastes**: Pasting 32 KiB+ of text (or any paste that would exceed the message limit) turns it into a text-file attachment so it doesn't bloat the prompt. Use `Cmd+Shift+V` (Apple) or `Ctrl+Shift+V` (Windows/Linux) to paste inline instead.

## Common prompts

Common prompts are instructions you send often, ready to insert without
retyping. Open **Prompts** in the composer, choose **Insert a common prompt** in
the command palette, or press **Ctrl+.**, which you can change in
**Settings → Keyboard shortcuts**. On mobile, open **Common Prompts** from the
plus menu. The prompt goes in at the cursor and waits for you to edit or send it.

If the cursor is right after a letter, the search starts with the word you were
typing. Choosing a prompt replaces that word; cancelling leaves your draft as it
was. After a space, punctuation, or a digit, the search starts empty.

On web and desktop, hold **Cmd** on Mac, or **Ctrl** elsewhere, to number the
first five results, then press **1** to **5** to insert one. Nothing is sent
until you send it.

Your environment builds the list from your conversations once a day, using the
model configured for thread titles, so you don't need to maintain it. Close
rewordings of one instruction merge into a single entry, while prompts that
differ in a detail stay separate. **Find new prompts** runs discovery now.
Discovery keeps your shorthand instead of expanding it. The picker remembers
what you typed before choosing a prompt and ranks that prompt higher when you
type it again.

Choose **Edit prompts** or press **Ctrl+,** to open the editor. Search the list,
select a prompt, and save changes to its title or text. **Cmd+1** to **5** or
**Ctrl+1** to **5** selects a result here instead of inserting it. Use **New
prompt** to add your own. Saved edits keep their learned searches and are left
unchanged by daily discovery. **Search prompts** returns to the picker, keeping
your selection and any unsaved edits. On mobile, switch between **Search** and
**Edit** at the bottom of the sheet.

Dismiss a prompt you don't want and discovery
won't add it back; choose **Undo** right away to restore it with its history.

## Formatting

The composer keeps the Markdown you type, including every delimiter. With
**Settings → Chat → Rich text composer** enabled, formatting appears while markers
hide away from the cursor. Move the cursor into a formatted span to edit its
markers directly. Backticks keep names such as `_build` and `node_modules`
literal. What you typed is what the agent receives.

Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---` show as lists,
tasks, quotes, headings and rules. Click a task checkbox to change `[ ]` to
`[x]`. Formatting shortcuts wrap or unwrap the selection: **Cmd+B / Ctrl+B**
for bold, **Cmd+I / Ctrl+I** for italics, **Cmd+E / Ctrl+E** for inline code,
and **Cmd+Shift+S / Ctrl+Shift+S** for strikethrough.
Use Cmd on Mac and Ctrl elsewhere. Strikethrough takes priority over the
settle-thread shortcut while the Rich text composer is focused.

Enter sends. **Shift+Enter** continues a list or quote; on an empty item it
moves out one level, then leaves it; **Tab** nests a list item under the one above and **Shift+Tab** moves it back out. Typing a code fence such as ` ```ts `
and pressing Enter adds a matching closing fence. Inside the fence, Enter
adds a line with the current indentation; **Tab** and **Shift+Tab** indent
or outdent code. To write after the block, move beyond its closing fence.
Choose its language while the cursor is outside the block. Formatting shortcuts,
checkbox changes and code-block actions can each be undone in one step.

Drafts above 12,000 characters show plain Markdown for responsiveness. `#1234`
without a space still looks up a pull request.

## Attach files

Attach up to **100 files** per message:

- **Images**: Up to 10 MiB each, 80 MiB total per message. HEIC/HEIF photos are converted to JPEG, and oversized photos are resized automatically.
- **Other files (including videos)**: Up to 50 MiB each (subject to environment limits). Video attachments pass a file path; only [Antigravity](./providers-antigravity.md#skills-and-attachments) sends supported videos natively to Gemini models.

Files upload to the environment's machine as soon as you attach them, and all uploads must finish before sending. Provider and model limits still apply.

- **Web and desktop**: Drag, paste, or pick files. Reloading before an upload finishes requires re-attaching.
- **Mobile**: Pick files, share into T3 Code via the system share sheet, or drag images in Android split screen.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

Choose your default follow-up behavior in **Settings → Chat → Follow-up behavior** (per client):

- **Queue**: Holds the message on the server for the next turn.
- **Steer**: Injects the message into the running turn (when supported by the agent).

Shortcuts while a turn is running:

- **Opposite action**: `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) uses the non-default action. If your send shortcut already requires `Cmd/Ctrl+Enter`, add `Shift`. On mobile, long-press the send button or use `Cmd/Ctrl+Return` on a hardware keyboard.
- **Steer oldest queued message**: `Cmd+Shift+Enter` (macOS) or `Ctrl+Shift+Enter` (Windows/Linux) sends the first queued message as a steer without touching your current draft. Remap `thread.steerQueuedMessage` in **Settings → Keybindings**, or add a rule in your [keybindings file](./keybindings.md#edit-the-configuration-file) to trigger it on `mod+enter` when the composer is empty:

```json
{
  "key": "mod+enter",
  "command": "thread.steerQueuedMessage",
  "when": "composerFocus && turnRunning && composerEmpty"
}
```

- **Edit most recently queued message**: `Option+Up` (macOS) or `Alt+Up` (Windows/Linux) at the start of the composer (`thread.editQueuedMessage`).

Slash commands (such as `/compact` or `/context`) wait for the current turn to finish rather than steering into it. [Goal](#goals) commands are the exception.

## Recover a thread

LastCode checks Codex and Claude threads when their updates stop being recorded.
Long thinking or tool calls alone do not trigger recovery. When the provider confirms
that the affected turn ended, LastCode reconciles its status automatically without
repeating the work. The recovery notice tells you when some output may be missing.

Use **Check now** or **Recover** in the thread's notice to check again. If automatic
recovery cannot finish, **Open repair thread** starts a separate investigation using
the project's default provider and model. Your original conversation stays in place;
**View repair thread** returns to the same investigation. Configure a project model
default first if LastCode asks for one.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments so you can preview them and queue messages offline. Uploads resume on reconnect, and drafts/queued messages survive app restarts and T3 Connect sign-out (restored when signing back into the same account).

## Custom models and defaults

- **Remembered defaults**: T3 Code remembers your last provider, model, and options for new threads. A project's configured model overrides this. Leaving reasoning level or service tier unset uses the provider's default.
- **Custom models**: Add unlisted models in **Settings → Providers → Models** (web and desktop; not supported for Antigravity, which uses its account catalog).
- **Rename a built-in model across all clients**: Add an entry in the server's `userdata/settings.json`:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Quote an assistant response

- **Web and desktop**: Select text in an assistant message and click **Cite in composer**. Click the pencil on the chip to add or edit a comment; click the chip to jump back to the source.
- **Mobile**: Long-press an assistant response, select text, and tap **Cite**. Tap a quote chip to edit its comment, remove it, or jump to the source message.

Quoted text and comments count toward the message length limit and are preserved across copy/paste and [stashed prompts](#prompt-stash).

## Recall a sent prompt

Press `ArrowUp` in an empty composer to cycle backward through earlier prompts in the thread, and `ArrowDown` to move forward. Only prompt text is restored (not attachments or context chips). Editing a recalled prompt turns it into a normal draft.

## Suggested next prompt

Enable **Settings → Labs → Suggest next prompt** (web and desktop) to show a predicted next message in the empty composer after a Claude or Codex turn completes.

- Press `Tab` to accept or `Escape` to dismiss.
- Each suggestion uses one cached request against your plan's usage. Claude skips suggestions on the first turn and near usage limits.
- Codex requires CLI version 0.165+ (update in **Settings → Providers**). Open Claude threads pick up the setting after restarting.

## Edit an earlier prompt

On web and desktop, select **Edit from here** under a sent message to rewind the conversation to before that message and return it to the composer:

- **Revert and keep changes**: Rewinds the conversation only.
- **Revert files too**: Restores workspace files to the checkpoint before that message (including your own edits). Only available for worktree threads when no other thread or active session shares that directory.

Rewinding removes later messages from the active thread and provider history (requires provider rewind support), but cannot undo external actions or separate provider memory.

## Prompt stash

On web and desktop, press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) to stash the current draft and its attachments (wait for uploads to finish first). Press the same shortcut in an empty composer to restore the stash (or open the stash menu if you have multiple).

- Holds up to 100 prompts in browser storage; stashes are never auto-deleted.
- Stashes with uploaded files must be restored in their original environment. Uploads expire after 24 hours; use **Attach again** or remove expired files before sending.

## Voice input

Dictate into the composer with the microphone button or `mod+shift+d` (web and desktop). Audio stays on-device or goes only to an environment/provider you explicitly choose in **Settings → Voice**. See [Voice input](./voice-input.md) for setup, mobile dictation, and microphone priority.

## Queued messages

Queued messages appear at the end of the thread (web/desktop) or above the composer (mobile). From a queued message you can:

- **Send now**: Injects it immediately into a running turn (or moves a slash command to the front of the queue).
- **Edit**: Opens the message and its attachments in the composer without losing your existing draft.
- **Remove**: Cancels the queued message.

If you stop the agent or the server restarts, queued messages pause in order. Click **Resume** in an empty composer (or send a new message) to continue. When the provider supports native continuation, **Resume** continues without sending a new prompt.

## Commands and skills

Type `/` for commands or `$` for skills from the selected environment and provider.

- Skills also appear in the `/` menu unless you disable **Settings → Chat → Show skills in slash menu** (under Advanced).
- Provider commands must start the message; T3 Code commands (like `/model`) and `$` skills work on any line.
- `/compact` reduces context usage when supported by the provider.
- `/clear` starts a fresh provider session in the same thread (earlier messages and diffs stay visible above a **New session** divider).
- After adding or changing skills, plugins, or MCP servers, run **Restart agent session** from the command palette so your next message picks up the new config.
- Turn on **Settings → Appearance → Thread details → Context window** to view reported context usage. For automatic idle compaction on Claude, see [compact long conversations](./providers-claude.md#compact-long-conversations).

In LastCode, enter `/annotate` to open the current thread's annotation editor. Enter `/annotate`
followed by Markdown to save the annotation directly without sending a message to the agent.
Annotations become available after the first message turns a draft into a saved thread.
They start expanded above the composer. Collapse one to keep it collapsed until you expand or edit
it. Turn off **Settings → LastCode → Expand thread annotations by default** to start added or
edited annotations collapsed.

## Goals

With Codex, Claude, and OpenCode 2.2.5+, send `/goal <criteria>` (for example, `/goal all tests in packages/api pass`) so the agent keeps working across turns until the goal is met.

- `/goal` shows the current goal; `/goal clear` removes it.
- Codex and OpenCode support `/goal pause` and `/goal resume` (stopping pauses the goal).
- On Claude, stopping ends the current turn but keeps the goal active for your next message.
- Sending a new goal or `/goal resume` while working interrupts the current turn unless queued; `/goal clear` and `/goal pause` interrupt only when the agent is actively working on the goal.

## Context in your message

Attached context—files, terminal excerpts, diff/file review comments, preview annotations, pull requests, and threads—appears as inline chips at your cursor. Click a chip to inspect or open its source; copy/paste and [Prompt stash](#prompt-stash) preserve chips across drafts.

- **Pull requests (`#`)**: On web and desktop, type `#` to browse recent PRs in the current repository (linked PRs appear first), type digits to match by number, or type a word to search by text.
- **Threads (`@`)**: Type `@` followed by part of its title, project or environment name to find threads across projects and connected environments. Archived threads and completed subagents can be references too. Bare `@` opens the file picker. On web and desktop, drag threads from the sidebar onto the composer, or use **Copy thread** and paste on any client.

  The agent reads a thread's history on demand. Across environments, it can read through your
  connected client or an existing [environment link](./remote-access.md#link-another-environment)
  with read access. For the client route, both environments must support thread references and
  your client needs read permission for both. Keep the client you sent from connected while the
  agent reads. If access is unavailable, check connections, read permissions, and server updates,
  or remove the reference from your draft. A reference does not message or change the thread, link
  machines, grant write access, or save an offline transcript.

- **Models (`@`)**: Type `@` and part of a model or provider name (e.g. `@opus` or `@opus:opencode`) to reference a model in your prompt (such as for delegation) without changing the thread's model.
- **Images vs. files**: Images keep a thumbnail shelf above the composer plus optional inline chips; files live only as inline chips (deleting the last chip removes the file).

## Attached files

Select any file chip in a draft or sent message to preview it (syntax-highlighted code/JSON, rendered/raw Markdown/HTML/CSV/TSV, audio playback, and ZIP folder browsing up to 50 MB). Large text files show a truncated preview—save the file to read it in full.

When a preview asks for a file password, enter it and select **Unlock**. T3 Code uses the password on your device. Web and desktop can unlock supported PDF, ZIP, Office, and OpenDocument files. The mobile app can unlock ZIP attachments, and Android can unlock PDFs. Ebooks protected by DRM need a compatible reader.

## Images and videos in messages

Select an image or video attachment or link to preview it.

- **Web and desktop**: Right-click media to save it or copy its path/URL.
- **Mobile**: Long-press a thumbnail and choose **Save or share**.

File links point to the file on the environment's machine, so moving or deleting the original breaks the preview—save a copy if you need to keep it.

## Preview links

Managed QA preview servers sleep after 24 hours of inactivity; opening a retained link restarts
the server. Archiving the thread or automatically suspending its workspace ends
the preview, so its old link cannot restart it. Open a retained link from its
thread so LastCode can restore it before opening either browser. Remote viewing
still requires the server to be reachable from your device.

If a link opened in the integrated browser cannot connect, choose **Ask agent to
restore preview**. The failed link and error go to the thread that owns the
preview. After the agent restores it, reload the page.

## Files outside the workspace

Following an agent's file link to a file outside the workspace opens it read-only. External HTML files cannot load neighboring scripts, styles, or images.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open rendered (HTML previews are sandboxed from your T3 Code session; line-specific HTML links open source view). On mobile, PDFs open in the native iOS viewer or an installed Android viewer.
