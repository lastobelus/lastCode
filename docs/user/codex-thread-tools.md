# Codex thread inspection

On supported hosts, LastCode adds `lastcode-thread` to the `PATH` of Codex sessions it starts. The command identifies
the current LastCode thread and reads active threads owned by the same LastCode environment:

```sh
lastcode-thread current --json
lastcode-thread list --json
lastcode-thread read <thread-id-or-unique-prefix> --turn-limit 5 --json
```

Thread IDs are resolved locally. An exact ID always wins; a prefix must identify exactly one
active thread. Ambiguous JSON responses include a small sorted candidate list and report when
additional matches were omitted. Archived and deleted threads are not included.

`list` returns at most the 50 most recently updated active threads, with thread ID as
a deterministic tie-breaker. When more exist, its JSON includes `threadsTruncated: true`
and `originalThreadCount`.

`read` bounds recent message text and activity summaries to one 64,000-character output
budget and caps activity records. Unresolved approval and user-input requests are retained,
with remaining activity slots filled by the newest activity. Its JSON reports when text or
activity counts were truncated.

The bundled thread command is currently available on POSIX Node hosts and packaged macOS.
Windows and packaged Linux AppImage Codex sessions still receive LastCode thread and home
identity, but do not receive a `lastcode-thread` launcher. Windows has no POSIX launcher;
AppImage executable and resource paths are transient mount paths.

To inspect a different host, first choose that host with an existing SSH alias and invoke the
wrapper stored in its LastCode home:

```sh
ssh <host> ~/.lastcode/userdata/bin/lastcode-thread list --json
ssh <host> ~/.lastcode/userdata/bin/lastcode-thread read <thread-id> --json
```

`~/.lastcode` is the default home. If that host uses a custom LastCode home, use its explicit
`userdata/bin/lastcode-thread` path. LastCode does not discover hosts or read SSH configuration.
