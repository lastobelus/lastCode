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

Before managed launch, run `vp run dev --dry-run --home-dir "$PWD/.t3"`
from the repository root and read `webPort` from its `[dev-runner]` output.
Use `http://localhost:<webPort>` as the requested preview URL. Launch
`vp run dev --home-dir "$PWD/.t3"` with the same working directory and
environment. To choose a port range, supply `T3CODE_PORT_OFFSET` to both the
dry run and the managed launch: the initial web port is `5733 + offset` and
backend port is `13773 + offset`. The runner can shift occupied ports, so use
the dry-run result, not the formula alone. `--port` selects the backend, not
the browser-facing web listener. If a port is taken between resolution and
launch, inspect the readiness failure and resolve a free pair again.

`preview_host` does not expose startup output or a terminal handle. After a
successful launch, obtain a fresh pairing URL with
`node apps/server/src/bin.ts pair --base-dir "$PWD/.t3"` from the same root.
This explicitly targets the isolated server and uses its recorded web origin.
Keep the returned token private; do not commit it or include it in reports.
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
waits for readiness. Navigate to the complete freshly minted pairing URL once with
`preview_navigate`, then use `preview_snapshot` and T3's interaction tools.
If the token was consumed or expired, repeat the isolated pairing command above
for a fresh one. Keep using the same tab.

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
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
