# Codex Thread Tools Plan

## Outcome

Give Codex an official, small LastCode-provided command for identifying its current
LastCode thread, inspecting another thread, sending that thread a user-directed
message, and waiting for the exact resulting turn when the user asks a question.

The feature is intentionally temporary and LastCode-only. It serves one user running
a handful of concurrent Codex threads across a few personally administered hosts. It
does not establish a general multi-agent orchestration platform.

## Source of Truth and Prior Art

This file is the source of truth for scope, sequencing, acceptance, and validation.
The implementation should reuse ideas, but not wholesale branches, from:

- upstream T3 Code PR #2829, especially its `current/list/read/send/wait` MCP tool
  semantics;
- upstream T3 Code PR #3004, especially server-authoritative current thread and
  workspace identity;
- the existing `t3` CLI's authenticated live-server and offline projection pattern in
  `apps/server/src/cli/project.ts`; and
- the existing LastCode shell snapshot, bounded thread detail, dispatch, event stream,
  and projected turn/message correlation.

PR #6573 is not the implementation base. Its V1 `list/send` behavior is narrower than
the read and exact-wait behavior required here.

## Product Contract

Codex receives a discoverable `lastcode-thread` executable in its `PATH`. The command
also remains reachable through the bundled `t3 thread` command tree so the wrapper has
no business logic of its own.

The initial command surface is:

```text
lastcode-thread current --json
lastcode-thread list --json
lastcode-thread read <thread-id-or-prefix> [--turn-limit <n>] --json
lastcode-thread send <thread-id-or-prefix> --message <text> --json
lastcode-thread wait '<compact-json-wait-handle>' [--timeout <duration>] --json
lastcode-thread send <thread-id-or-prefix> --message <text> --wait [--timeout <duration>] --json
```

Human-readable output may be added where it is essentially free, but stable JSON is
the primary Codex interface. Every successful result includes a scoped identity with
`environmentId` and `threadId`; current-thread output also includes project, workspace,
provider instance, and provider-native Codex thread identity when available.

Commands that accept a plain thread ID always address the server on which the command
is running. Cross-host addressing is performed by choosing the SSH host first, not by
embedding an environment selector in a local command. Wait handles carry and validate
the environment ID so they cannot be resumed against the wrong server.

Codex performs cross-host lookup by running the same command through the user's
existing SSH aliases. The command itself is local-only. A normal lookup is:

```text
local lastcode-thread read
  -> if absent, ssh <known-host> ~/.lastcode/userdata/bin/lastcode-thread read
```

There is no LastCode host registry, SSH configuration parser, credential delegation,
desktop connection-catalog dependency, or server-to-server transport in this plan.
The example path is the default LastCode home; a host configured with a custom base
directory uses that explicit home's `userdata/bin/lastcode-thread` path.

Plain `send` returns `{ kind: accepted, environmentId, threadId, messageId }` and does
not enable later waiting. Only `send --wait` marks a request for correlation. Its
`timed-out`, `transport-unknown`, and `dispatch-unknown` outcomes include an opaque
wait handle containing its scoped thread
identity and new message ID:
`{ kind: wait-handle, environmentId, threadId, messageId }`. A timed-out result nests
that object as `{ kind: timed-out, waitHandle }`; `wait` accepts the nested handle
object from any of those outcomes, serialized as compact JSON and passed as one
shell-quoted UTF-8 argument, never the plain accepted result. The decoder accepts
exactly the typed handle schema and
rejects extra/missing fields. A timed-out handle can be
passed back to `wait`, which resumes waiting for that specific message's projected
provider turn and resulting assistant response. It never interprets an arbitrary newer
turn as the answer.

`read` and successful `wait` CLI output use a 64,000-character presentation budget.
For `read`, message text and activity summaries share that single newest-first budget,
and activity records also have a conservative recent-record cap. JSON includes
`textTruncated` and `originalTextChars` when selected text exceeds the budget, plus
additive activity-count truncation metadata when the record cap applies; metadata and
identifiers are never truncated. The live server may hydrate its existing bounded-turn detail
snapshot before the CLI applies this output bound; this temporary local transport does
not add a second text-limited SQL/query stack.

## Deliberate Constraints

- Codex only. No Claude, Cursor, Grok, OpenCode, or generic provider abstraction.
- User-directed use only. No autonomous coordinator mode, recursively delegated
  workflows, or background callback scheduler.
- Expected scale is fewer than ten threads and a few hosts. Prefer bounded linear
  scans and one request per inspected host over caches, brokers, queues, or indexes.
- No UI changes on web, desktop, or mobile.
- No MCP dependency and no separate daemon.
- No thread creation, interrupt, fork, merge, worktree handoff, or scheduled task
  commands.
- No content search or standalone resolver command in the first version. `list` plus
  exact or unambiguous ID-prefix resolution inside `read` and `send` is sufficient.
- No fuzzy resolution. Ambiguous prefixes fail closed and return candidates.
- No compatibility layer for pre-feature binaries or schemas. This is a single-stack
  LastCode feature and may evolve with its caller.
- No direct SQL in the wrapper or Codex instructions. Server-owned CLI/query services
  own persistence details.
- No offline mutation. Read commands may use the existing offline projection fallback;
  `send` and `wait` require the live owning LastCode server.

## Slice and Pull Request Stack

The umbrella branch is `lastcode/codex-thread-tools`, opened against
`lastcode/main`. Its first commit is this reviewed plan. The umbrella PR remains open
until the user explicitly rubberstamps the assembled feature.

Each serial slice starts from the latest umbrella head, opens a PR targeting the
umbrella branch, and is squash-merged into the umbrella only after its own validation
and review gates pass. Later slices are created after the preceding squash merge so
they never retain obsolete pre-squash ancestry.

### Slice 1: Codex identity and read-only inspection

Branch: `lastcode/codex-thread-read`

1. Add a `t3 thread` command group and `current --json` using the existing Effect CLI
   patterns. Reuse or extract the CLI runner that resolves the active home, discovers a
   live server, issues and revokes a short-lived local session, calls the typed
   authenticated HTTP API, and falls back to projection queries for offline reads.
   Issue only the minimum orchestration-read scope and revoke it on success, failure,
   interruption, or timeout; do not copy the project command's administrative scope.
2. Materialize a tiny runtime wrapper under the active T3/LastCode state directory and
   prepend that bin directory only to Codex provider processes.
3. Pass the authoritative LastCode thread ID and active home through the Codex
   adapter/runtime input and inject only `T3CODE_THREAD_ID` and `T3CODE_HOME` into the
   Codex process. `current` derives environment, project, workspace, and provider
   metadata from that thread's server-owned shell/detail state and the existing
   environment-descriptor endpoint. Preserve `CODEX_THREAD_ID` as a separately named
   provider-native identity when available; never conflate it with the LastCode thread
   ID.
4. Make the wrapper pin its owning home explicitly on every invocation. For an ordinary
   Node-hosted server it executes that server's runtime and bundled CLI entry with
   `--base-dir <owning-home>`. For packaged macOS LastCode it executes the LastCode
   binary while preserving inherited `ELECTRON_RUN_AS_NODE=1`, the bundled server CLI
   entry, and the same explicit base directory. The wrapper contains invocation details
   only and delegates all behavior to `t3 thread`. Windows and packaged Linux AppImage
   hosts are out of scope for the POSIX wrapper; AppImage executable and app-resource
   paths live under a transient mount. Codex still receives LastCode identity variables
   on those hosts, but no thread command is added to PATH.
5. Add bounded `list` and `read` commands over the existing shell and thread-detail
   snapshots. `read` accepts an exact or unambiguous thread-ID prefix and returns
   a small deterministic candidate subset plus original-count truncation metadata when
   resolution is ambiguous. `list` returns at most 50 deterministically ordered threads
   and reports truncation plus the original thread count when that bound is exceeded.
6. Default `read` to a small recent-turn window and impose a conservative maximum.
   Include thread status, project/workspace/branch, recent turns, and transcript
   content needed to answer “what is this thread up to?” without dumping the full
   database.
7. For offline transcript reads, call the bounded thread-detail projection query
   directly rather than the command read model, which intentionally omits hydrated
   thread bodies. Compose only the SQLite persistence and projection snapshot-query
   layers through a read-only database client that skips WAL setup and migrations;
   offline inspection must not start the writable orchestration engine or its projectors
   alongside a live server.
8. Preserve lifecycle visibility for active snoozed, settled, pending-input, and
   working threads. Do not mutate those states. Archived and deleted threads are out
   of scope and return not found.
9. Document the supported local-first/SSH composition for Codex. Do not add host
   discovery code.
10. Add focused tests for new/resumed Codex identity propagation, environment injection,
    active-home selection, wrapper/desktop/SSH invocation, live-server and offline-detail
    reads, least-privilege authorization cleanup, bounds, ambiguity, not-found,
    lifecycle state, JSON schema, and missing current context.

Acceptance:

- `current` identifies the exact environment, LastCode thread, project, workspace, and
  provider identity without SQLite/transcript heuristics, and non-Codex providers are
  unchanged.
- Codex can list a small host's threads and inspect a supplied exact or unique-prefix
  ID through the supported command.
- The same command works when invoked explicitly over SSH on another LastCode host.
- Read operations never wake, unsnooze, unsettle, or otherwise modify a target thread.

### Slice 2: User-directed tell/send

Branch: `lastcode/codex-thread-send`

1. Add live-server-only `send` using the existing authenticated orchestration dispatch
   endpoint and `thread.turn.start` command. Issue only the orchestration-read and
   orchestration-operate scopes needed for target lookup and dispatch, and revoke them
   on every exit path.
2. Generate and retain the new user message ID before dispatch. Return
   `{ kind: accepted, environmentId, threadId, messageId }`; this is deliberately not a
   wait handle and cannot be passed to `wait`.
3. Resolve the target from the current shell snapshot and use its existing runtime and
   interaction settings rather than inventing defaults.
4. Bound message text with the existing provider send-turn input limit and reject an
   oversized message before dispatch.
5. Reject deleted or missing local targets with typed errors. Let the existing decider
   remain authoritative for lifecycle and concurrency validity rather than duplicating
   orchestration rules in the CLI.
6. Add focused tests for successful dispatch, exact command payload, least-privilege
   scope issuance and cleanup, live-server requirement, invalid target, oversized
   input, decider rejection, exact/prefix ambiguity, and accepted-result encoding.

Acceptance:

- A user can tell Codex “Tell THREAD_ID to ...”, and Codex can dispatch the instruction
  to that exact local or explicitly SSH-addressed thread.
- The command reports accepted persistence, not successful completion.
- Dispatch failures are explicit and never reported as accepted.

### Slice 3: Exact ask/wait

Branch: `lastcode/codex-thread-wait`

1. Extend CLI `send` with `trackRequestCorrelation: true` only for `send --wait`.
   Standalone `wait` accepts a strict `kind: wait-handle` object previously returned by
   a timed-out, transport-unknown, or dispatch-unknown `send --wait`/`wait` outcome. Add
   the
   optional literal field to the client turn-start command, normalized internal
   command, and turn-start-requested payload; preserve it through the normalizer and
   decider. Absence means current plain-send/UI behavior.
   Generate stable command and message IDs before dispatch. If the dispatch response is
   lost, retry once with the same IDs so the engine's command receipt deduplication can
   return the original acceptance. If the response remains ambiguous, return
   `{ kind: dispatch-unknown, waitHandle }` without claiming acceptance; `wait` either
   finds the persisted correlation or returns correlation-not-found.
2. Add one narrow `projection_turn_request_correlations` table keyed by
   `{threadId, messageId}`, with nullable `turnId`, `state = pending | started | error |
interrupted`, `requestedAt`, and `resolvedAt`. Project every existing
   correlation-tracked `thread.turn-start-requested` event into an idempotent pending
   row. The tracking marker is carried from the CLI's start command to its request
   event; events from before this feature and ordinary UI starts do not create rows.
   Absence of the marker is covered by a negative projection test.
   Do not change the current single-pending-row behavior, ingestion assumptions,
   cursor, or pagination of `projection_turns`.
   Delete a thread's correlation rows when that thread is deleted; otherwise retain the
   small per-tracked-request history with the thread and add no cleanup scheduler.
3. For marked requests only, keep the originating message ID in the
   `ProviderCommandReactor` closure that already
   receives `thread.turn-start-requested`; do not widen generic provider start
   contracts with a LastCode message ID. Funnel every pre-turn exit—missing/deleted
   context, missing/invalid message, request construction, provider start error, and
   interruption—through one finalization helper.
4. Add one internal `thread.turn-request.resolve` command and
   `thread.turn-request-resolved` event with `{threadId, messageId, outcome}`, where
   outcome is either `{ kind: started, turnId }` or
   `{ kind: terminal, state: error | interrupted, completedAt }`. Derive its command ID
   deterministically only from the originating `thread.turn-start-requested` event ID,
   not outcome fields or timestamps, so exactly one resolution can persist and reactor
   retry/replay is idempotent. Add the schemas to the existing
   orchestration unions, but keep it out of the public web/mobile thread-detail stream;
   it is internal bookkeeping, not user-visible activity. Its decider path validates
   the correlation identifiers but does not require the target thread to still exist,
   so a deletion race can resolve or harmlessly no-op the row.
5. Project `thread.turn-request-resolved` through one transactional, idempotent
   repository operation on the correlation table. Started outcomes set the exact
   `turnId`; pre-turn terminal outcomes set `error` or `interrupted`. It never changes
   `projection_turns`, overwrites an existing terminal outcome, or associates one
   message with two turns. Resolution is update-only and no-ops when deletion already
   removed the keyed row, so late resolution cannot recreate deleted state. Public JSON
   uses `error`, not `failed`.
   The reactor finalizer is one-shot: whichever `started`, `error`, or `interrupted`
   outcome first persists for the deterministic request command wins; later competing
   calls deduplicate. Repeated finalizer calls may carry different timestamps without
   changing identity.
6. Add a typed authenticated HTTP wait endpoint. Its success schema is a tagged outcome
   union for `completed`, `error`, `interrupted`, and `timed-out`; timeout and terminal
   outcomes are HTTP successes, while
   typed thread-not-found, correlation-not-found, wrong-environment, query, and existing
   authorization errors map to explicit route errors/statuses. A deleted thread returns
   thread-not-found immediately; an existing thread with an invalid or unprojected
   handle returns correlation-not-found. Give it a conservative
   server-side maximum duration and a separate CLI timeout appropriate for a long-held
   wait. Set the CLI transport deadline beyond the requested server deadline so the
   tagged `timed-out` response normally wins; do not inherit the existing one-second
   project-command timeout. If the local transport deadline or connection fails first,
   return `{ kind: transport-unknown, waitHandle }` without claiming that the server
   timed out or that the turn is unfinished, then revoke the read-only credential. The
   command issues only orchestration-read scope and revokes it on every exit path.
   Only `completed` guarantees `turnId` and bounded assistant response text. Pre-turn
   `error` or `interrupted` outcomes omit both; post-start terminal outcomes may include
   `turnId` but do not invent assistant text.
7. Extract the existing WebSocket subscription's buffered subscribe-before-read race
   pattern into a small internal helper that accepts its own event predicate. Use it for
   wait without exposing the correlation event to the public thread stream: subscribe
   to the owning thread's raw domain events before the initial correlation/turn
   projection read, then re-read only when relevant events arrive. Do not sleep or poll.
8. Once correlation supplies a turn ID, read terminal state and assistant response from
   the existing exact turn/thread projections. If the exact turn row is not projected
   yet, remain subscribed and re-read on that thread's session/turn events; cover both
   correlation-first and runtime-projection-first orderings. Treat completed, error,
   and interrupted distinctly.
   Timeout returns a resumable wait handle and does not interrupt the target.
9. Validate the wait handle's environment ID against the local server, then add `wait`
   and `send --wait` composition. On success, return the exact turn identity,
   terminal state, and completed assistant response correlated to the sent message.
   `send --wait` revokes its read/operate dispatch credential immediately after accepted
   persistence, writes exactly one recovery line to stderr as
   `LASTCODE_WAIT_HANDLE=<compact-json-handle>` without adding another stdout record,
   then issues a separate read-only credential for the long wait; operate privilege is
   never retained across waiting, timeout, interruption, or resume. User interruption
   may end the final result stream, but the already-emitted handle remains available.
   The recovery line is a machine-readable framing convention, not a shell assignment
   to `eval` or `source`; Codex extracts the JSON value and passes it back as one quoted
   argument.
10. Add focused migration/repository, command/event union, decider,
    reactor-finalization, transactional
    projection-ordering, route, and CLI tests for immediate completion,
    pending-before-provider failure, pending-to-running-to-completed,
    failure/interruption, timeout-and-resume, event-before-subscribe race protection,
    unrelated thread/turn events, wrong-environment handles, concurrent UI/tool sends,
    thread-deletion cleanup, and server restart after the correlation event is durable.
    A restart before provider adoption—or in the narrow interval after provider
    acceptance but before the correlation outcome persists—exercises the existing V1
    limitation: wait times out with the same resumable handle and does not claim
    completion or retry automatically. Closing that external-side-effect durability gap
    is explicitly outside this temporary feature. Also test distinct plain-accepted and
    timed-out-handle encoding, wait-after-thread-deletion, missing correlation, duplicate
    finalization, competing outcomes, absent tracking, long-wait timeout configuration,
    least-privilege authorization cleanup, and bounded response output.
    Cover lost dispatch response with same-command retry and `dispatch-unknown`, plus
    interruption after accepted persistence with early handle emission and credential
    cleanup. Deterministically force a wait connection/deadline failure and assert
    `transport-unknown`, handle recovery, credential cleanup, exactly one recovery line
    on stderr, and exactly one final JSON object on stdout.

Acceptance:

- “Ask THREAD_ID ...” can send one message and wait for the exact resulting turn.
- An unrelated newer turn can never be mistaken for the requested answer.
- A known but unresolved correlation times out visibly; an invalid or unprojected
  handle returns correlation-not-found. Neither is guessed from a newer turn.
- “Do this, and when finished tell THREAD_ID ...” needs no workflow engine: Codex runs
  its local work and then calls `send`.

## Validation and Review

### Plan gate

- Run up to ten full plan-review rounds with Luna at high reasoning over `basic`,
  `best-practices`, and `KISS` lenses; skip the UI/component lens because the plan has
  no UI surface.
- Stop early when every applicable lens is quiet. Reopen a quiet lens if a later review
  materially changes scope, architecture, validation, or acceptance.
- Record applied, defended, and deferred findings in this file.

### Slice gate

For every slice:

1. Implement with a Sol-medium subagent on the slice branch.
2. Run the smallest focused tests, formatting/lint checks, and affected package
   typechecks required by the slice.
3. Run up to five Luna-high implementation-review rounds over correctness, KISS, and
   repository best practices; add UX only where command behavior warrants it and skip
   UI/component review.
4. Apply or concretely defend every finding, rerun affected validation, and require all
   applicable lenses to become quiet.
5. Push the exact reviewed head, open the slice PR against the umbrella branch, inspect
   all current-head comments/reviews/checks and unresolved threads, and request Codex
   review if available.
6. Squash-merge only with an explicit exact-head match after focused validation and
   review gates are clean.

The repository's `pnpm lastcode:merge` command intentionally rejects PRs whose base is
not `lastcode/main`, so it cannot merge slice PRs. For each slice, perform the same
open/non-draft/base/head/mergeability/unresolved-thread checks manually and use GitHub's
`--match-head-commit` squash merge. Do not run the nightly checkpoint trigger for slice
merges.

### Umbrella gate

After all slices are merged into the umbrella:

- run focused end-to-end CLI tests for `current`, `list/read`, `send`, and exact
  `wait`;
- run `vp check`, `vp run typecheck`, `git diff --check`, and `pnpm lastcode:ci` on the
  exact clean umbrella head against the fetched `origin/lastcode/main` base;
- run a final Luna-high assembled-stack review if slice merges or integration fixes
  materially changed cross-slice behavior;
- report the exact umbrella head, validation, review state, unresolved-thread count,
  and remaining risks; and
- leave the umbrella PR open. Do not run `pnpm lastcode:merge` until the user explicitly
  rubberstamps it.

Manual app QA is not required because this is a backend/CLI-only feature. A bounded
command-level smoke test may use a disposable LastCode home; never run a server against
the user's live `~/.lastcode/userdata` database.

The user's explicit request to implement and babysit this stack invokes the
`implement-plan` and guarded LastCode delivery workflows and authorizes their final
repo-wide validation commands despite the repository's normal focused-check default.

## Review Record

Requested depth: up to 10 rounds with Luna at high reasoning. Review stopped after
round 7 because every applicable lens was quiet. The UI/component lens was skipped
because the plan has no UI surface. Across all rounds, 58 findings were applied, 6 were
defended to preserve the user's explicit scope or delivery workflow, and 0 were
deferred. Intermediate designs mentioned below were superseded by later KISS rounds;
the product contract and three slices above are the implementation source of truth.

- Round 1 `basic`: six findings applied. The plan dropped archived reads, minimized
  provider identity injection, named the offline detail-query path, clarified local
  thread addressing, specified the wait HTTP/timeout contract, and retained durable
  message correlation for turns that fail before receiving a provider turn ID.
- Round 1 `best-practices`: eight findings applied. The plan now pins the wrapper's
  owning home and packaged invocation, limits the first version to POSIX Node hosts and packaged macOS,
  uses least-privilege command scopes, bounds send input, carries exact message
  correlation through provider-start outcomes, rejects overlapping tool sends, uses
  existing terminal-state vocabulary, and reports pre-adoption restart orphaning
  without adding automatic recovery.
- Round 1 `KISS`: three findings applied and two defended. The plan removed the
  standalone `find` command and wait-handle versioning, and requires reuse of the
  existing buffered subscription race pattern. The explicit user-requested review
  budgets and final implement-plan/full-CI gate remain; they stop early when quiet and
  guard the exact cross-thread behavior that would otherwise be difficult to diagnose.
- Round 2 `basic`: five findings applied. Exact waits now use per-message pending
  projection rows and explicit reactor correlation outcomes, `current` names the
  environment descriptor as its identity source, `send --wait` accepts the same
  exact-or-prefix target as `send`, and transcript/answer output has a concrete
  truncation contract.
- Round 2 `best-practices`: six findings applied and one defended. The plan now removes
  arbitrary pending-message adoption, defines one deterministic correlation
  command/event and a single reactor finalizer, requires atomic order-independent
  projection, specifies the HTTP outcome/error union, and uses one fake-clock-testable
  adoption deadline. The 64k limit remains a CLI/SSH presentation bound over the
  existing local bounded-turn snapshot; a second limited SQL/query surface is not
  justified at the stated scale.
- Round 2 `KISS`: five findings applied and one defended. Exact wait correlation moved
  into a separate, narrow projection so existing pending-turn ingestion and pagination
  remain unchanged; internal correlation events stay out of public streams; orphan
  timing and dispatch sequence were removed. Final broad validation remains because
  the user explicitly requested the implement-plan and guarded LastCode delivery
  workflow.
- Round 3 `basic`: four findings applied and two boundaries defended. Correlation rows
  are now feature-era/CLI-only, deletion cleans them up, the internal resolution path
  tolerates a deleted thread, and wait handles correlation-before-turn-projection. The
  plan explicitly accepts timeout across the existing provider-acceptance/persistence
  crash window instead of importing V2 recovery machinery, and records the user's
  authorization for final repo-wide delivery validation.
- Round 3 `best-practices`: four findings applied. The tracking marker now has an exact
  typed command/normalizer/event path, one stable request-derived resolution command ID
  makes outcome persistence one-shot, volatile timestamps do not affect idempotency,
  and deleted-thread versus missing-correlation wait errors are distinct.
- Round 3 `KISS`: four findings applied. Current identity and inspection are one
  read-only slice, correlation-marker plumbing moves entirely into the wait slice, only
  marked requests enter the reactor finalizer, and late resolution updates existing
  rows only so deleted state cannot reappear.
- Round 4 `basic`: two findings applied. Plain send and timed-out wait handles now have
  distinct schemas, only `send --wait` creates correlation, standalone `wait` only
  resumes a timed-out handle, and the slice-specific encoding tests match that split.
- Round 4 `best-practices`: two findings applied. `send --wait` drops operate privilege
  before opening a read-only wait session, and resumable handles have their own nested
  `kind: wait-handle` schema so a plain accepted result cannot be mistaken for one.
- Round 4 `KISS`: two findings applied. Standalone wait receives one shell-quoted
  compact-JSON handle with strict decoding, and the terminal outcome union now states
  exactly when turn identity and assistant text are present.
- Round 5 `basic`: one finding applied. Server timeout normally precedes the CLI
  transport deadline, while transport failure still returns the already-known handle
  and revokes the read-only credential so the wait remains resumable.
- Round 5 `best-practices`: two findings applied. Ambiguous dispatch retries once with
  stable IDs and otherwise returns `dispatch-unknown` without claiming acceptance;
  confirmed dispatch emits its handle before blocking so interruption preserves a way
  to resume while credentials are still cleaned up.
- Round 5 `KISS`: three findings applied. Candidate handles from dispatch, transport,
  and timeout outcomes are all valid standalone-wait inputs; connection uncertainty is
  `transport-unknown`, not `timed-out`; and interruption recovery uses one precisely
  framed stderr line while stdout remains one final JSON object.
- Round 6 `basic`: one finding applied. Focused CLI coverage now forces transport
  uncertainty and verifies its handle, credential cleanup, and exact stderr/stdout
  framing; the recovery record is explicitly machine-readable rather than shell code.
- Round 6 `best-practices` and `KISS`: clean. No material findings remained.
- Round 7 `basic`: clean. Basic, best-practices, and KISS were all quiet; the plan is
  ready for implementation.

## Implementation Results

Pending.
