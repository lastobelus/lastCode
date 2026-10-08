---
name: test-t3-app
description: Test T3 Code's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Use T3's built-in Browser panel for verification. Initialize the background
tab and attempt navigation before declaring it unavailable. If the tools are
absent or navigation reports an unsupported host, explain the blocker and stop
verification.
Do not install or switch to another automation system. For native mobile
testing, use [test-t3-mobile](../test-t3-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root through `preview_host` when available, retaining its managed
terminal and lease. Follow `docs/lastcode/preview-handoffs.md` for the hosting
contract. Use a foreground command; do not detach the process. Otherwise retain
its terminal session. Use the worktree's ignored `.t3` state.

Before managed launch, resolve the absolute path of this worktree's `.t3`
directory. Substitute that literal path for `<isolated-home>` in these commands
(the quoted argument works in POSIX shells, PowerShell, and cmd.exe):

```text
./node_modules/.bin/vp run dev --dry-run --home-dir "<isolated-home>"
./node_modules/.bin/vp run dev --home-dir "<isolated-home>"
```

Run the dry run first and read `webPort` from its `[dev-runner]` output. Use
`http://localhost:<webPort>` as the requested preview URL, then give the second
command to `preview_host` with the same working directory and environment.
Use the workspace-installed executable for this unattended launch; a global
Vite+ proxy can wait before starting the command. On Windows use
`node_modules\\.bin\\vp.cmd`. If the workspace executable is missing, repair setup
before launching.
To choose a port range, supply `T3CODE_PORT_OFFSET` through the tool's environment
overrides (and the dry-run process environment): the initial web port is
`5733 + offset` and backend port is `13773 + offset`. The runner can shift
occupied ports, so use the dry-run result, not the formula alone. `--port`
selects the backend, not the browser-facing web listener. If a port is taken
between resolution and launch, resolve a free pair again.

For an authenticated T3 dev handoff, configure the reusable dev credential
using `docs/operations/development.md#reusable-dev-credential`. Reuse an existing
configured value; otherwise generate one value once for this isolated setup and
retain it as `T3CODE_DEV_AUTH_TOKEN` in the managed launch's environment. Supply
`browserAuth: "t3-dev"` to `preview_host`. The app then renews browser access when
the user opens the clean handoff link, including after its cookie expires or
its server sleeps. Do not generate new credentials inside a replayable command
or emit a one-time pairing link as the lasting QA handoff.

The automation tab can initially pair with that same configured credential.
Keep it in the selected QA profile. Never replace a shared configured credential
or restart the user's LastCode to prepare QA.

Keep pairing URLs and credentials private: never commit them, include them in
reports, or capture them in screenshots. Do not redirect startup output into
files: a managed relaunch can create another secret-bearing file without an
agent present to clean it up.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Use the Browser panel

Routine automated QA against isolated development state does not need a
separate permission prompt. Keep it in the background so the user can continue
using LastCode. Call `preview_status` and `preview_profiles`, then explicitly select `Default`
or an existing dedicated QA profile with
`preview_open({ open: false, profileName: "Default", reuseExistingTab: false })`.
Verify its returned profile. GitHub work requiring login uses a separate tab in
`Logged in Developer`; never change the default profile to obtain that session. Retain the returned `tabId` and pass it to subsequent tools; reuse that
QA tab for the rest of the task. Do not hide or repurpose a tab the user is
inspecting.

A newly created blank tab can initially report `available: false` while its
native browser starts. Navigate before declaring it unavailable; navigation
waits for readiness. Initially pair the automation tab using the configured dev
credential and `preview_navigate`, then use `preview_snapshot` and T3's interaction
tools. Keep using that tab. The user's lasting handoff is the clean URL with
managed browser authentication described above, not this initial pairing URL.

If managed hosting fails readiness, inspect the startup diagnostics returned by
`preview_host`, the launch command, actual listening port, and ownership before
retrying. The failure reports readiness and terminal status, not transcript
contents: commands can load credentials that cannot be safely redacted. Do not
infer a specific startup error from status alone. Opening or focusing a browser
does not repair a failed server launch. Report the concrete
startup failure if it cannot be repaired; do not ask for browser permission as
a workaround.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the saved handoff, isolated state, dependencies, and panel available while the
user inspects or iterates, including after the process sleeps.
An assistant turn ending is not teardown. Do not stop a managed handoff at turn end; explicit stop or thread deletion
cancels its future reopening.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.

When manual QA is requested, prepare the scenario and a clean integrated-browser
link without asking the user to begin a QA window. Leave the result ready even
if acceptance comes much later. Ask under the machine policy only when starting
back-and-forth human QA or foreground application control. Human acceptance is
still pending until the user provides it.

If a browser fault persists after a bounded diagnostic attempt, record the exact
failed operation and recovery condition. New feature commits alone do not fix a
browser fault. Do not repeatedly send another thread the same QA request; use
thread coordination to investigate the common failure, with one clear owner.
