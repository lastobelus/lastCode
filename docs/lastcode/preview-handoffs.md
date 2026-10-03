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

Repeated clicks and remounting the preview do not resend an accepted request.
A failed send can be retried with the same request identity. Loading the URL
successfully permits a new recovery request for a later failure. The action
does not replace the composer draft or choose a different thread.

When receiving a restoration request, inspect the exact link and the original
launch context before restarting anything. Preserve the user's saved work and
the original URL when possible, verify the restored page in the integrated
browser, and report the result in the same thread.

## Native hosting requirement

The request action is a recovery fallback; it does not establish a 24-hour
hosting lease. Saved Handoffs preserve destinations and renew asset access, but
an ordinary HTTP link still depends on its server. A native managed preview
needs retained launch command, working directory, environment, owning thread
and terminal, handoff time, and fixed expiry. Reopening must use that context
without another user message, and expiry must stop only the managed process.

Do not present a provider-owned background process, a longer command timeout,
`nohup`, a detached shell, or an external daemon as the native handoff contract.
Do not delete temporary assets or stop a managed preview merely because the
agent's turn ended. Keep HTML source as a persistent workspace artifact and
identify whether the link uses LastCode asset hosting or a development server.
