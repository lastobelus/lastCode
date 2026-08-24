# Codex thread tools

On supported hosts, LastCode adds `lastcode-thread` to the `PATH` of Codex sessions it starts.
The command identifies the current LastCode thread, reads active threads, and sends a
user-directed message to a live thread owned by the same LastCode environment:

```sh
lastcode-thread current --json
lastcode-thread list --json
lastcode-thread read <thread-id-or-unique-prefix> --turn-limit 5 --json
lastcode-thread send <thread-id-or-unique-prefix> --message <text> --json
lastcode-thread send <thread-id-or-unique-prefix> --message <text> --wait --timeout '10 minutes' --json
lastcode-thread wait '<compact-json-wait-handle>' --timeout '10 minutes' --json
```

Thread IDs are resolved locally. An exact ID always wins; a prefix must identify exactly one
active thread. Ambiguous resolution includes a small sorted candidate list and reports when
additional matches were omitted. Archived and deleted threads are not included.

`list` returns at most the 50 most recently updated active threads, with thread ID as
a deterministic tie-breaker. When more exist, its JSON includes `threadsTruncated: true`
and `originalThreadCount`.

`read` bounds recent message text and activity summaries to one 64,000-character output
budget and caps activity records. Unresolved approval and user-input requests are retained,
with remaining activity slots filled by the newest activity. Its JSON reports when text or
activity counts were truncated.

`send` requires the owning LastCode server to be running and never mutates an offline database.
It uses the target thread's current runtime and interaction settings. A successful response is
`{"kind":"accepted","environmentId":"...","threadId":"...","messageId":"..."}`: this
confirms that LastCode persisted the request, not that the provider finished it. Blank or
oversized messages, missing or ambiguous targets, authorization failures, and rejected dispatches
fail without reporting acceptance.

Add `--wait` when the caller needs the exact resulting turn rather than dispatch acceptance.
`send --wait` cannot target the caller's current thread because that queued turn cannot begin
until the current command returns; use plain `send` for a self-directed follow-up.
LastCode emits one `LASTCODE_WAIT_HANDLE=<compact-json>` recovery line on stderr before the
long wait, then prints one final JSON result on stdout. A completed result includes the exact
turn ID and a response bounded to 64,000 characters. Timeouts do not interrupt the target;
their nested `waitHandle` can be passed back to `lastcode-thread wait`. A
`transport-unknown` or `dispatch-unknown` result also preserves that handle without claiming
whether the request completed or, for dispatch, whether acceptance was observed. Plain `send`
does not create wait state and its accepted JSON cannot be used as a wait handle.

The bundled thread command is currently available on POSIX Node hosts and packaged macOS.
Windows and packaged Linux AppImage Codex sessions still receive LastCode thread and home
identity, but do not receive a `lastcode-thread` launcher. Windows has no POSIX launcher;
AppImage executable and resource paths are transient mount paths.

To inspect a different host, first choose that host with an existing SSH alias and invoke the
wrapper stored in its LastCode home:

```sh
ssh <host> ~/.lastcode/userdata/bin/lastcode-thread list --json
ssh <host> ~/.lastcode/userdata/bin/lastcode-thread read <thread-id> --json
ssh <host> ~/.lastcode/userdata/bin/lastcode-thread send <thread-id> --message <text> --json
ssh <host> ~/.lastcode/userdata/bin/lastcode-thread wait '<compact-json-wait-handle>' --json
```

`~/.lastcode` is the default home. If that host uses a custom LastCode home, use its explicit
`userdata/bin/lastcode-thread` path. LastCode does not discover hosts or read SSH configuration.
