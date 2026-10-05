# Reconcile Wait for PR and the built-in PR watcher

This draft PR is a place to explore, brainstorm, and later implement one coherent PR-watching experience. It starts with an [interactive ELI5 HTML explainer](explainer.html) and this fresh-thread handoff. Download/open the HTML in a browser to use the mockups; GitHub's file view shows its source.

## Start a new thread with this brief

Continue work in this PR on branch `lastcode/pr-watcher-reconciliation`. Read this handoff and the explainer, inspect the current source, and discuss the open decisions before treating the proposed UI or architecture as accepted. Keep later implementation in this same PR and update its description as the scope becomes concrete. This initial commit contains proposal artifacts only, explicitly requested by the maintainer despite the usual rule against committed working plans.

**Do not run local CI, Quick CI, or merge this PR until the user gives new direction.** The initial task does not request implementation, review requests, or either waiting mechanism. Publishing the draft may trigger normal GitHub automation; that does not authorize babysitting or merging it. Do not arm both observers merely to follow this proposal PR.

## Goal and evidence

Make waiting visible and understandable while retaining exact revision-specific delivery checks. The built-in watcher reports news; Wait for PR evaluates readiness for a captured PR/head/base. Neither grants merge authorization.

The explainer records source inspection on 2026-10-05 at `8c62bda01e4fb37ff07512325facad3123aef36a`, with pinned source links. This proposal branch started from `05fcbc0f71` on `origin/lastcode/main`. Recheck source before implementing: the explainer is dated evidence, not a live runtime receipt or a full UI audit. Its PR numbers, timings, and visible status controls are examples.

At the inspected revision, the server watcher polls about once a minute, persists watch state, follows the head, and queues notifications behind an active turn. It has an eye icon and watch/stop controls in the linked-PR panel, not a dedicated Project Action. It reports check transitions, remarks, and conflicts; it does not establish exact-head clean Codex review or all resolved discussions. Settled threads are skipped, closed/merged PRs stop watching, and read failures or repeated comment-only wakes can stop a watch. Persisted watch state alone cannot establish current health or freshness.

Wait for PR is a resumable managed action with visible progress and structured outcomes. It captures identity, evaluates GitHub CI and Codex evidence, and handles target/base drift and explicit stack targets. A server restart can leave a process-lost action: resuming retained results does not restart its polling script. The guarded merge remains a separate final check. Runtime guidance and repository skills must agree about which observer to use.

## Three directions to discuss

| Direction | Benefit | Cost or limitation |
| --- | --- | --- |
| A. In-thread status card (recommended starting point) | Makes mechanism, freshness, head, queued updates, stop reason, and controls visible while the agent is idle. | Needs truthful server state and shared client behavior, not just a badge. |
| B. Compact header chip with expanded details | Keeps status close to the title with little visual weight. | Pending delivery, stale reads, and stop reasons are hidden unless expanded. |
| C. Background activity lane | Makes several PRs or a stack understandable together. | Adds navigation and UI complexity for a common single-PR thread. |

The HTML lets readers switch between these alternatives and sample status states. Recommendation A is an invitation to evaluate, not an approved design. Prefer one observer per PR by default; deciding whether it is native notifications plus an on-demand readiness evaluator, an adapted action, or another small integration is still part of the work.

## Questions for brainstorming

- Which user intents select notifications versus a delivery wait, and how should the agent explain that choice?
- Can the existing strict readiness evaluator be reused without maintaining two polling loops? Where should that service boundary live?
- Does one observer mean per thread, environment, or PR across linked threads? How should explicit opt-in to both behave?
- What data should persist: observer identity, last successful read, current head, queued delivery, stop reason, and who started it? Which facts should be derived?
- How should superseded check notifications be refreshed or coalesced at delivery while preserving meaningful old-commit review findings?
- How should restart, disconnection, settled/archive states, missing provider capabilities, stacks, and multiple environments appear and recover?
- Which runtime instructions, skills, and user-facing guidance must change together so agents select one mechanism consistently?

## Acceptance cases for a later implementation

- Default waiting uses one observer and does not double-wake or duplicate GitHub polling for the same ownership scope. Stop/restart races cannot resurrect an obsolete watch.
- A push or base change invalidates readiness from an older revision. Readiness still requires exact head/base GitHub CI, CI Gate, appropriate Codex evidence and handled findings, and no unresolved review threads. A green notification never means merge permission; guarded merge independently revalidates.
- A notification queued during an active turn is checked against current identity before delivery. Superseded cancellation noise can be grouped without losing real failures or review comments on older commits.
- Visible status distinguishes active monitoring, stale/failed reads, queued updates, settled/archived behavior, and stopped states, with a reason and recoverable controls. No saved flag falsely claims current health.
- Server restart preserves native watch ownership and truthful freshness. Action process loss distinguishes restarting a wait from delivering/discarding a retained result, respecting the one-unfinished-continuation limit.
- Web and desktop, mobile, local and remote/relay/tunnel connections, multiple environments, and agent/MCP entry points receive explicit behavior decisions. Provider limitations are visible, including current action-resume support boundaries.
- Stacks preserve pinned parent-chain identity and delivery order. Stacked-ready remains distinct from readiness to merge to the main branch.
- Waiting alone runs no local CI or builds. Later tests cover meaningful transitions with deterministic synchronization; integrated client QA follows project guidance after implementation is authorized.

## Source map

Paths are relative to the repository root; use the explainer's pinned links for the historical snapshot.

| Concern | Starting points |
| --- | --- |
| Polling, persisted observation, stop limits | `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` |
| Check/remark changes and wake selection | `apps/server/src/orchestration-v2/pullRequestWatch.ts` |
| Queued delivery and lifecycle guards | `apps/server/src/orchestration-v2/Orchestrator.ts` |
| Wire contracts | `packages/contracts/src/threadPullRequest.ts` |
| Current watch controls | `apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx` |
| Action progress UI | `apps/web/src/components/chat/ComposerActionResume.tsx` |
| Action recovery and delivery | `apps/server/src/actionResume/ActionResume.ts` |
| Strict readiness and GitHub evidence | `scripts/lastcode-wait-for-pr.ts`, `scripts/lastcode-github-ci.ts` |
| Agent workflow and merge policy | `.agents/skills/babysit/SKILL.md`, `.agents/skills/lastcode-pr/SKILL.md`, `docs/lastcode/release.md` |
| Cross-client behavior | `packages/client-runtime`, `apps/mobile`, `apps/desktop` |

Browser disconnect handling from the background-QA work is a separate follow-on. Do not expand this PR into browser session recovery unless the user deliberately changes its scope.

## Initial validation

Source inspection and artifact/diff checks only. No local CI, Quick CI, test suites, or integrated UI validation were run for this proposal. No feature code or runtime state is changed. The draft stays open for later work and is not ready to merge.
