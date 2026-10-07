# QA preview handoffs

A QA handoff must be usable when the user returns, without another agent turn.
Retain its launch recipe, isolated state, dependencies, and source until the user
explicitly stops the preview or deletes the owning thread. Temporary processes
sleep after 24 hours; opening the saved link or retained Browser panel starts
them again. Sleeping is resource cleanup, not expiration of the handoff.

Preparing manual QA is unattended work. Finish setup and deterministic checks,
leave the requested scenario ready, and provide a clean link that opens in the
thread's integrated Browser panel. Do not ask the user to start a QA window just
to prepare it. Actual back-and-forth human QA and foreground application control
still follow the machine interaction policy; waiting for acceptance must not
tear down the prepared setup.

## Background QA

Routine automated QA runs in a thread-owned background browser against isolated
development state. It does not require a separate permission prompt or prevent
the user from continuing to use LastCode. Discover profiles with `preview_profiles`, then select `Default` or an existing
dedicated QA profile explicitly in
`preview_open({ open: false, profileName: "Default", reuseExistingTab: false })`.
Reuse its returned
`tabId` for navigation, interactions, and evidence throughout the task. Do not
hide or repurpose a tab the user is inspecting. Keep foreground application control and human
acceptance subject to the machine interaction policy.

For a signed-in browser identity, call `preview_profiles` to list the connected
desktop's existing profiles and configured default. Pass either an exact unique
`profileName` or stable `profileId` to `preview_open`, for example
`preview_open({ open: false, reuseExistingTab: false, profileName: "Work" })`.
For GitHub uploads and other GitHub work requiring a login, explicitly select
`Logged in Developer` in a separate tab. Ordinary QA keeps its bare or dedicated
QA profile; never change the default to obtain a login. This selects the new
tab's cookie jar without changing the user's default.
Unknown profiles and duplicate names fail; use an ID to disambiguate. Reused tabs
keep their profile: an explicit mismatch opens a new tab when `tabId` is omitted,
or fails when an exact `tabId` was supplied. Check the returned `profileId` and
`profileName`; `preview_status` reports these too. Profile selection requires a
desktop app that advertises support, and never falls back on an older host.
New tabs retain the user's configured viewport, including Fill panel. To use a
fixed size for evidence, explicitly call `preview_resize` on the returned tab.

A newly created blank tab may briefly report `available: false`; navigation
waits for its browser to become ready. This is different from a managed server
that fails to start. For managed hosting, run the server in the foreground,
choose a free port explicitly, and make the requested URL match that listener.
A responding URL alone is insufficient: LastCode must attribute its listener
to the managed terminal. Inspect startup diagnostics before retrying a failed
launch; opening a visible browser does not repair it.

## Recovering an unreachable preview

Managed previews recover natively. They show **Retry preview** when recovery
fails; they do not send a new agent request. For unmanaged destinations, the
unreachable page's **Ask agent to restore preview** action sends the exact
failed URL, browser error, and available page/tab context to the thread owning
that preview. It uses the ordinary thread-message path and the thread's saved
provider settings. A sent confirmation means the server accepted the message;
it does not mean the preview is already restored. Reload after restoration.

Repeated clicks, reopening the preview, and requests from another client share
one server-saved request identity for the owning thread and exact URL. A failed
send can be retried with that identity, including after an app or server restart.
A confirmed page load releases the identity, including when the original URL
redirects, so a later failure can request recovery again. Merely changing the
address bar does not confirm a page load. The action does not replace the
composer draft or choose a different thread.

When receiving a restoration request, inspect the exact link and the original
launch context before restarting anything. Preserve the user's saved work and
the original URL when possible, verify the restored page in the integrated
browser, and report the result in the same thread.

## Native managed handoff

When `preview_host` is available, launch a temporary QA server with it before
posting the link. Supply its exact shell command, absolute working directory,
local HTTP or HTTPS URL, required environment overrides, and source worktree
path. Keep HTML and supporting assets in the workspace. For example, an HTML
preview can use `python3 -m http.server 5173 --bind 127.0.0.1` with a workspace
working directory and `http://localhost:5173/example.html`.

Prefer HTTP unless HTTPS itself is under test. Readiness probes can accept a
self-signed certificate on loopback; browsers retain their own certificate
policy, so an HTTPS handoff must also be usable in the intended browser.

The successful tool result establishes a retained handoff and its current
24-hour process window. LastCode owns the terminal and persists the recipe across
turn completion and server restarts. Opening the link in its owning thread, or
returning to its retained Browser panel, restores a stopped server without an
agent message. A healthy page keeps its current form state when revisited.

At the process deadline, LastCode closes only that preview's terminal and marks
the handoff sleeping. A later opening starts a fresh process window after
readiness succeeds; viewing an already-running process does not extend its
window. Source and dependencies remain protected while the handoff exists,
including through archive. **Stop all previews & processes** cancels reopening
and releases protection after cleanup; deleting the thread does the same. A
failed stop keeps protection until cleanup succeeds. Never stop the terminal or
remove its files merely because the agent turn ended or acceptance is pending.

For an isolated T3 dev app, supply `browserAuth: "t3-dev"` and the same fixed
`T3CODE_DEV_AUTH_TOKEN` in the managed launch's environment. On each browser
opening, the owning environment verifies its listener, restarts it if needed,
and issues a fresh short-lived credential for that navigation. The requested
page, query, and fragment survive authentication. Emit only the clean QA URL;
never put a pairing token in a report or saved handoff. Other applications keep
their own authentication setup, which must be verified in the selected profile.

Retained commands must be replayable: do not regenerate credentials or reset
fixtures in the launch command. Use isolated state and preserve its dependencies.
A server restart does not authorize overwriting the prepared scenario. A
conflicting listener is reported rather than navigating to an unrelated app.
The original origin remains reserved until explicit stop or thread deletion.

An existing server cannot be adopted merely by remembering its URL: relaunch it
through `preview_host` to establish native ownership. One managed listener owns
a local origin; use a distinct port for another preview. Native browser recovery
uses the owning environment and thread, never an unrelated thread or public
website. Existing browser connection limits still apply when the environment's
preview URL is unreachable from the client. Desktop, web, and mobile prepare
owned links before opening them. Private-network environment addresses replace
loopback destinations for remote clients. A saved previous private address is
rewritten only when it is known to belong to that environment; unknown LAN
addresses are left unchanged. This does not create a tunnel or make a
loopback-only listener reachable from another machine.

Persistent HTML files can instead use LastCode's existing file-preview hosting
without a temporary server. Keep the source and neighboring assets available.
Saved Handoffs preserve destinations and renew asset access; ordinary HTTP links
created outside native hosting still depend on their original server.

Do not present a provider-owned background process, a longer command timeout,
`nohup`, a detached shell, or an external daemon as this handoff contract. The
request button remains a fallback for unmanaged links.
