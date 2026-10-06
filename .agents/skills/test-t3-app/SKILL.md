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
vp run dev --dry-run --home-dir "<isolated-home>"
vp run dev --home-dir "<isolated-home>"
```

Run the dry run first and read `webPort` from its `[dev-runner]` output. Use
`http://localhost:<webPort>` as the requested preview URL, then give the second
command to `preview_host` with the same working directory and environment.
To choose a port range, supply `T3CODE_PORT_OFFSET` through the tool's environment
overrides (and the dry-run process environment): the initial web port is
`5733 + offset` and backend port is `13773 + offset`. The runner can shift
occupied ports, so use the dry-run result, not the formula alone. `--port`
selects the backend, not the browser-facing web listener. If a port is taken
between resolution and launch, resolve a free pair again.

`preview_host` does not expose startup output or a terminal handle. For ordinary
QA, mint a fresh standard-scope pairing URL after launch:

```text
node apps/server/src/bin.ts pair --base-dir "<isolated-home>"
```

Administrative QA, such as Connections management, needs admin scopes that
`pair` does not grant. Before launching, configure the reusable dev credential
using `docs/operations/development.md#reusable-dev-credential`, including its
trusted-hostname requirement. Reuse the configured value when present; otherwise
generate one value once for this QA setup with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
and retain it as `T3CODE_DEV_AUTH_TOKEN` in the managed launch's environment
overrides. Never generate a new value inside the replayable launch command.
Navigate the dedicated tab to `<web-origin>/pair#token=<credential>` once; the
dev server seeds this credential with administrative scopes. Reuse the same
credential on managed recovery, and pair again if the browser session expires.
Do not replace a shared configured credential or restart the user's LastCode.

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
using LastCode. Call `preview_status`, then
`preview_open({ open: false, reuseExistingTab: false })` to create a dedicated
QA tab. Retain the returned `tabId` and pass it to subsequent tools; reuse that
QA tab for the rest of the task. Do not hide or repurpose a tab the user is
inspecting.

A newly created blank tab can initially report `available: false` while its
native browser starts. Navigate before declaring it unavailable; navigation
waits for readiness. Navigate to the complete pairing URL once with
`preview_navigate`, then use `preview_snapshot` and T3's interaction tools.
If the token was consumed or expired, follow the scope-aware recovery above.
Keep using the same tab.

If managed hosting fails readiness, inspect the startup diagnostics returned by
`preview_host`, the launch command, actual listening port, and ownership before
retrying. The failure includes a bounded output excerpt captured before terminal
cleanup. Treat that output as private diagnostic evidence, not publishable PR
content. If diagnostics are unavailable, report that missing evidence rather
than claiming to have diagnosed the launch. Opening or
focusing a browser does not repair a failed server launch. Report the concrete
startup failure if it cannot be repaired; do not ask for browser permission as
a workaround.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
