# Codex Computer Use Indicators After a Turn

Codex's native Computer Use cursor or app badge can remain visible after a
LastCode thread finishes its reply. This makes it unclear whether the agent has
released the app. As of October 8, 2026, there is no verified, supported LastCode
fix for immediate dismissal. Treat this as an upstream limitation pending a
supported Computer Use release mechanism or a confirmed upstream fix.

## Ownership and evidence

The desktop indicator belongs to Codex's bundled Computer Use helper, rather
than LastCode's browser preview. T3 Code's matching
[issue #11875](https://github.com/pingdotgg/t3code/issues/11875) remains open.
[Maintainer triage](https://github.com/pingdotgg/t3code/issues/11875#issuecomment-5678849684)
attributes the leftover overlay to the Codex/Sky helper and identifies no T3 host
API for dismissing it. The dim cursor inside a T3 browser preview is a separate
surface with different behavior.

Related Codex reports remain open:

- [#32363](https://github.com/openai/codex/issues/32363): an orphan mascot and
  badge after a browser/Picture-in-Picture failure.
- [#36958](https://github.com/openai/codex/issues/36958): a cursor and helper
  processes surviving stop/exit, including activity through another client.
- [#35659](https://github.com/openai/codex/issues/35659): capture streams and
  Computer Use clients retained while idle. An
  [embedding app-server report](https://github.com/openai/codex/issues/35659#issuecomment-5227095739)
  describes the absence of a public close/dispose/disconnect API in the helper
  runtime examined there. A proposed helper reaper was
  [retracted](https://github.com/openai/codex/issues/35659#issuecomment-5197472091)
  because killed clients were respawned.

These reports support the ownership and lifecycle concern; they do not prove
the cause of every lingering indicator in LastCode. The reported LastCode
symptom has not been reproduced under controlled conditions in this investigation.

## Related idle cleanup is already upstream

[T3 Code #15979](https://github.com/pingdotgg/t3code/issues/15979) concerns
per-thread MCP servers accumulating in a shared Codex app-server. It was closed
by [PR #16917](https://github.com/pingdotgg/t3code/pull/16917), merged October 7,
2026. The current LastCode source includes this cleanup.

[ProviderSessionManager](../../apps/server/src/orchestration-v2/ProviderSessionManager.ts)
unloads an inactive thread after the default 30-minute idle timeout, defers
unloading when that thread has pending background work, and reloads it for its
next turn. The
[Codex adapter](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)
implements unloading through `thread/unsubscribe`. Codex's
[documented unsubscribe behavior](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)
also permits an inactivity grace period before the native thread is unloaded.
These lifetimes do not guarantee that an indicator disappears when a reply
ends. PR #16917 does not add native overlay dismissal, and its effect on this
symptom remains unverified.

## Operational decision

Keep the existing idle cleanup and defer a LastCode-specific implementation.
Do not terminate the shared Codex runtime after each turn or add a helper-process
reaper: other threads and background work may still need those resources, and
process termination is not a reliable app-release protocol. A lingering
indicator alone does not establish whether input or capture is still active.

The workaround reported in T3 Code #11875 is to quit and reopen the application.
That interrupts provider work and is an operator decision, not automatic
cleanup. If the problem recurs, record the operating system, LastCode and Codex
versions, the affected app, a screenshot, and whether the Computer Use helper is
still running after the turn. Revisit this decision when upstream exposes a
supported release API or ships a fix verified against the native indicator.
