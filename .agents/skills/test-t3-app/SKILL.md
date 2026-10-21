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

Choose the route before launching. Record the machine that owns the app and the
machine that actually runs the Browser page; the agent's machine alone does not
identify the browser host. A loopback URL is usable only by a browser on that
same machine. An attached viewer does not tell you where the browser process
runs. When the tool advertises `browserHost`, ordinary agent QA can select
`"environment"` to run beside the app; named desktop sign-ins select
`"desktop"`. When the native desktop Browser runs elsewhere, use `--share` in
both the dry run and managed launch, then navigate to the runner's published
HTTPS origin. Do not first try the unshared loopback recipe remotely.

For a remote desktop Browser, pass the runner's published HTTPS URL directly
to `preview_navigate({ tabId, url: "<published-https-url>" })`. An
environment-port target constructs a loopback URL; changing its protocol does
not select the published hostname or its managed authentication route. Before
navigation, check the local and published HTTPS
`/.well-known/t3/environment` descriptors once and require the same environment
ID. A successful pairing-token POST does not establish that the earlier remote
descriptor check is reachable.

`--host` configures the backend, not the web listener. The runner clears
`T3CODE_WEB_BIND_HOST` for ordinary dev, so setting that variable is not a
replacement for `--share`. Let the runner own sharing; do not install a proxy or
configure a sharing service manually.

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root through `preview_host` when available, retaining its managed
terminal and lease. Follow `docs/lastcode/preview-handoffs.md` for the hosting
contract. Use a foreground command; do not detach the process. Otherwise retain
its terminal session. Use the worktree's ignored `.t3` state.

Before managed launch, resolve the absolute path of this worktree's `.t3`
directory. Substitute that literal path for `<isolated-home>` in the selected
recipe (the quoted argument works in POSIX shells, PowerShell, and cmd.exe).
When the Browser runs on the same machine as the app, use the local recipe:

```text
./node_modules/.bin/vp run dev --dry-run --home-dir "<isolated-home>"
./node_modules/.bin/vp run dev --home-dir "<isolated-home>"
```

When the native Browser runs on another machine, use the shared recipe instead:

```text
./node_modules/.bin/vp run dev --dry-run --share --home-dir "<isolated-home>"
./node_modules/.bin/vp run dev --share --home-dir "<isolated-home>"
```

Run the selected recipe's dry run first and read `webPort` from its
`[dev-runner]` output. Use `http://localhost:<webPort>` as the requested hosting
URL, then give that recipe's second command to `preview_host` with the same
working directory and environment. For the shared recipe, Browser navigation
uses the published HTTPS route rather than the hosting URL.

After the shared managed launch, obtain that URL on the app host with the
read-only command `tailscale serve status --json`. The hosting result retains
the supplied loopback URL and does not expose the runner's terminal output.
In `Web`, select the single mapping key ending in `:<webPort>` whose root
`Handlers["/"].Proxy` is `http://127.0.0.1:<webPort>`. Its published URL is
`https://<mapping-key>/`. Check its environment descriptor against the local
one before Browser navigation, as described above. A missing, ambiguous or
mismatched mapping is a sharing-readiness failure even when the local lease
is active; do not guess the URL from the environment connection or configure
a replacement mapping. Keep the status output and concrete URL private.

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

If the first shared navigation displays the pairing page, automatic dev
authentication has not passed. Ordinary pairing may allow the feature's own QA
to continue, but record that intervention separately and report the retained
lease URL scheme and published browser URL scheme to the browser-repair owner.
Do not describe a manually paired session as an unattended preview success.

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
using LastCode. Call `preview_status`. When the tool
advertises `browserHost`, start isolated QA beside the app with
`preview_open({ open: false, browserHost: "environment", profileName: "Incognito", reuseExistingTab: false })`.
Environment hosting supports only `Default` and `Incognito`; select `Default`
when the check needs persistent environment storage. Any named desktop profile,
including a dedicated QA profile or `Logged in Developer`, requires
`browserHost: "desktop"` and the shared recipe when the app is remote. Discover
that desktop's profiles with `preview_profiles` before its dedicated open;
environment-hosted QA uses the built-in choices without that desktop lookup. Omitting
the host keeps the current policy even when opening a new tab or selecting a
different profile. When the tool does not advertise the selector, explicitly
select `Default` or an existing dedicated QA profile with
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
Development previews start with the LastCode sidebar enabled and active. Verify
that mode before checking LastCode sidebar features; a deliberate mode change
is valid only when the scenario calls for another sidebar.
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
