# QA preview handoffs

A QA link is a handoff to the user. The required lifetime is 24 hours from
handoff: it must open after the agent's turn ends, reopening a stopped preview
must restore it within that window, and its temporary server must stop at expiry
without a cleanup request from the user. Viewing or reloading does not extend
the window.

## Recovering an unreachable preview

The unreachable page's **Ask agent to restore preview** action sends the exact
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

The successful tool result establishes a fixed 24-hour lease and returns its
handoff time and expiry. LastCode owns the terminal and retains the launch
context across turn completion and server restarts. Opening the link in its
owning thread, in either the integrated or system browser, restores a stopped server without sending an agent message. A
failed page load also tries native recovery before offering the request button.
Repeated launch, viewing, and recovery do not extend the expiry. At expiry,
LastCode closes only that lease's terminal. It retains the source worktree while
the lease is active; do not stop the terminal or remove its files at turn end.
If LastCode itself is stopped, no preview server runs; reopening after LastCode
starts can recover only an unexpired lease.

An existing server cannot be adopted merely by remembering its URL: relaunch it
through `preview_host` to establish native ownership. One managed listener owns
a local origin; use a distinct port for another preview. Native browser recovery
uses the owning environment and thread, never an unrelated thread or public
website. Existing browser connection limits still apply when the environment's
preview URL is unreachable from the client. Desktop, web, and mobile prepare
owned links before opening them. Private-network environment addresses replace
loopback destinations for remote clients; this does not create a tunnel or make
a loopback-only listener reachable from another machine.

Persistent HTML files can instead use LastCode's existing file-preview hosting
without a temporary server. Keep the source and neighboring assets available.
Saved Handoffs preserve destinations and renew asset access; ordinary HTTP links
created outside native hosting still depend on their original server.

Do not present a provider-owned background process, a longer command timeout,
`nohup`, a detached shell, or an external daemon as this handoff contract. The
request button remains a fallback for unmanaged links or failed native recovery.
