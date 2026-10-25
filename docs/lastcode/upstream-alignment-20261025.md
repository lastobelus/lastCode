# Upstream alignment review for October 2026 (PT)

**Status:** In Progress. The analysis is complete. No repair has been merged, and nothing here counts as acceptance yet.

## Outcome

LastCode's architecture holds up against upstream. Most LastCode services do jobs upstream does not do, so we keep them. Seven known defects need repairs, each in its own PR. The first, [#481](https://github.com/lastobelus/lastCode/issues/481), is why baseline Full CI fails today, so it merges before anything else. The other upstream features can come in later through the existing service boundaries, each with its own focused proof. Nothing here calls for new architecture, a new framework, a compatibility layer or a second coordinator.

**What we have not shown yet:**

- No repair is merged and verified.
- Nothing proves that installed build `0.1.3-nightly.20261025.3655` contains or runs this source.
- No integrated client pass exists.
- No human check has passed.

**Done means:**

- Each of the seven repairs has baseline evidence, passing focused checks, an independent review and clean CI on its current head.
- The repairs are merged in dependency order.
- One integrated pass is recorded on the merged source revision, and its retained preview is ready.
- Three visual judgments stay deferred for the maintainer.

Installed-build acceptance is not part of done.

## Ranked actions

### Now: the seven repairs, in this order

|   # | Issue                                                                                    | Why it ranks here                                                                                                                       | Current state                                                                                                                                                                                                                                                                                              |
| --: | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   0 | [#481 Unused orchestration export](https://github.com/lastobelus/lastCode/issues/481)    | Baseline Full CI fails on it, so it blocks every other merge.                                                                           | [PR #488](https://github.com/lastobelus/lastCode/pull/488); independent review clean, remote gates pending.                                                                                                                                                                                                |
|   1 | [#475 Committed event publication](https://github.com/lastobelus/lastCode/issues/475)    | Cancellation between commit and publication can lose notifications and lane release, which affects durable delivery.                    | [PR #485](https://github.com/lastobelus/lastCode/pull/485). Its worker reproduced the failure on the baseline. Expanded acceptance passed 82 focused tests on Node 26.12.1 and a bounded independent review at local head `ad508ab120…`; that acceptance commit awaits #481 before rebase and publication. |
|   2 | [#476 Delegated background follow-up](https://github.com/lastobelus/lastCode/issues/476) | Later results from a background child never reach the parent.                                                                           | [PR #484](https://github.com/lastobelus/lastCode/pull/484). Its worker reported the baseline failure (missing `delegatedTaskId`), passing focused tests and a clean review. CI is pending, and the PR still needs a rebase after #481.                                                                     |
|   3 | [#486 Setup shell readiness](https://github.com/lastobelus/lastCode/issues/486)          | The setup command is written before the shell is ready. The repair must also preserve update-drain admission around the deferred write. | Confirmed in source; baseline regression assigned.                                                                                                                                                                                                                                                         |
|   4 | [#477 Codex Default clears Plan](https://github.com/lastobelus/lastCode/issues/477)      | Codex mode depends on a copied prompt instead of native mode selection.                                                                 | [PR #483](https://github.com/lastobelus/lastCode/pull/483); baseline regression reproduced, 147 focused tests pass, independent review clean; remote gates pending.                                                                                                                                        |
|   5 | [#479 Attachment prompt references](https://github.com/lastobelus/lastCode/issues/479)   | Accepted attachments can drop out of the prompt at the size budget.                                                                     | Six regression cases failed before the fix; 96 focused tests pass afterward and independent review is clean. Publication is in progress.                                                                                                                                                                   |
|   6 | [#487 Relative draft media](https://github.com/lastobelus/lastCode/issues/487)           | Relative audio and video in drafts fail authorization.                                                                                  | Relative audio/video failures reproduced before the fix; 35 focused tests pass on Node 26.12.1 and independent review is clean. Publication is in progress.                                                                                                                                                |

The order follows risk: unblock CI, then durable delivery, setup admission, provider modes, prompt integrity and draft media. Only #481 is a hard prerequisite. The others can be worked on in parallel, but each one rebases after #481 and gets fresh current-head CI. A review or CI result from an older head does not carry over. If a rebase changes something that was already reviewed, rerun the affected checks and the review. PRs for #479, #486 and #487 are not open yet.

### Now: proof that does not depend on the repairs

- Run automation batches B1–B8 against the service boundaries most likely to break: authority, Pause and Actions, cross-environment reads, recovery, PR watch, retained preview, published files and cleanup. Each batch starts as `not_executed`.
- After the repairs merge, record one integrated pass on the exact merged `lastcode/main` SHA. Then prepare the retained preview for three deferred visual judgments.

### Next: adapt upstream features after the repairs

Shell-created PR linking, the older-settled shelf, the Settings and Usage modal routes, and PDF, SVG, media and desktop seams. Each goes in its own scoped PR with the checks listed in the appendix.

### Deferred

- Newer Vite+ together with the bundle-scanner change.
- Mobile workspace-detail selection: its own PR, with native verification through `test-t3-mobile`.
- Expanding the dashboard.
- Redesigning archive and recovery.
- LAN, relay and tunnel acceptance.
- Verifying the installed binary.

## Keep, adapt, replace, retire

| Decision                        | Area                                                                                                                                         | When                              | Why, and what proves it                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep**                        | Forge definitions and drivers (`9a85aac901`, `7368bd307b`, `814bd67250`, `6e79211743`)                                                       | Already present                   | The registry is the shared capability boundary for web, mobile and MCP. Keep LastCode's deliberate repository and release policy rather than guessing from host names.                  |
| **Adapt**                       | Shell-created PR linking (`dca46e2b24`)                                                                                                      | Next                              | Use `SourceControlDefinition.changeRequestCreateCommand`, shell recognition and the link service together. Keep explicit link and watch ownership. C5 covers it.                        |
| **Keep**                        | Persistence and indexed search (`6ed47b538c`, `97548db62d`, `80455376f0`, `e19fe0837b`, `bb7783e295`)                                        | Already present                   | Transactional reads keep their write context, and search opens unloaded threads. No second index or shim.                                                                               |
| **Adapt**                       | Older-settled shelf (`e57c093cdd`)                                                                                                           | Next; highest cross-client risk   | Contracts, server selection, cursor, reducer and the web and mobile lists move together. Upstream's 93% payload figure is not a LastCode measurement. See the appendix.                 |
| **Keep**                        | Pause and durable Actions                                                                                                                    | Now (validate)                    | One admission gate for every automatic producer, plus a durable terminal outcome and exactly one continuation. Upstream snooze, Stop and goals do not replace this. B2 and B5 cover it. |
| **Keep**                        | Dashboard requests and reports                                                                                                               | Now; expansion deferred           | Human commitments stay independent of provider goals and answered questions. Mobile parity is not established.                                                                          |
| **Keep**                        | Cross-environment reads, guest access and OAuth as separate authorities                                                                      | Now (permission gate)             | Share or session expiry and OAuth scopes never widen captured caller authority. B1, B3 and B7, plus a separate transport result.                                                        |
| **Keep the seam**               | Provider lifetime                                                                                                                            | Now                               | Provider facts are observed at adapters; durable decisions stay in orchestration. Keep exact-turn acknowledgment, barriers, drain hooks and the central host-settings merge.            |
| **Keep**                        | Archive, incident recovery, grouping and runtime-layer wiring                                                                                | Now (tests); redesign deferred    | Family consent, unread work and exact run and attempt recovery stay as services. B4 and B8, plus `runtimeLayer.update-drain.test.ts` when wiring changes.                               |
| **Keep**                        | Retained preview and file publication                                                                                                        | Now (acceptance); viewers later   | Upstream has no replacement for the managed recipe, auth, browser ownership or exact published paths. New viewers use the existing signer. B6–B8.                                       |
| **Keep**                        | Lazy dependency preparation and cleanup ([#398](https://github.com/lastobelus/lastCode/pull/398))                                            | Now (validate)                    | Setup only links environment files; the Action installs locked dependencies. #486 repairs shell timing, not this design.                                                                |
| **Adapt**                       | Settings and Usage modal routes (`3faeb9e6f9`)                                                                                               | Next                              | Move LastCode settings onto upstream's `_chat.settings.*` routes. Keep the archive scope exception, scopes, search targets and composer draft. No forwarding routes.                    |
| **Adapt; retire old selectors** | Mobile workspace detail (`8c0670b2be` and follow-ups)                                                                                        | Deferred to its own native PR     | Centralize detail ownership in workspace tabs. Retire old helpers only as their callers move.                                                                                           |
| **Adapt**                       | PDF, SVG, media and desktop seams (`532023a241`, `34e9c56b9b`, `7bafc40c17`, `efea68679f`, `140de68f25`; desktop `bbdc13640c`, `3d00499936`) | Next, after #479 and #487         | Make an explicit decision for each provider and client. Use remote asset URLs and guest restrictions. Keep desktop profile and root ownership.                                          |
| **Adapt together**              | Newer Vite+ and bundle scanner (`c916261760` with `d2f6ff4581d0417b9d750d6a0bfcd6af975349ed`)                                                | Deferred to the toolchain upgrade | The scanner must recognize bare path comments. C4 plus package evidence at the upgrade SHA. The current lockfile pins 1.3.0.                                                            |
| **Replace and retire**          | Copied Codex mode prompt                                                                                                                     | Now, inside #477                  | Native mode selection replaces it. App, browser and device context stay.                                                                                                                |
| **Keep retired**                | PR polling Action ([#419](https://github.com/lastobelus/lastCode/pull/419))                                                                  | Done                              | Native watch supplies news, and a reaction means review started, not approved. Filtering child tools (`e641761e2a`) is cleanup, not a proven auth bug.                                  |
| **Keep retired**                | Custom question attention ([#456](https://github.com/lastobelus/lastCode/pull/456))                                                          | Done                              | Native pending questions own attention. Historical events still decode. The upstream MCP approval response was reverted (`44f977f4e8` → `2bc2d80e79`), so it is not available.          |

## Evidence

| Fact                      | What it shows                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source baseline           | `c909106a31be7aa452a31fce86bd32d47716fadb`. The tag `lastcode/checkpoint/v0.1.3-nightly.20261025.3655` peels to this commit.                                                                                                                                                                                                                                                          |
| Installed application     | `0.1.3-nightly.20261025.3655` is a label the user supplied. Package contents, binary identity and running processes have not been checked.                                                                                                                                                                                                                                            |
| Upstream window           | [`a1db449fe4`](https://redirect.github.com/pingdotgg/t3code/commit/a1db449fe4fecafcb473340771163e791b7fb3d6) (exclusive) through [`557db6cb4e`](https://redirect.github.com/pingdotgg/t3code/commit/557db6cb4eb7ebe5d9b1300ecce8e05f1929fc39) (inclusive). Shared base: [`e9d61252f6`](https://redirect.github.com/pingdotgg/t3code/commit/e9d61252f6fd8369b80fe8f7e07209cbbb7221d9). |
| Inventory                 | 2,501 first-parent commits: 2,442 already in the baseline's ancestry and 59 newer ones absent. Those 59 are commits, not 59 missing features or defects.                                                                                                                                                                                                                              |
| Baseline Full CI          | [Run 40195278314](https://github.com/lastobelus/lastCode/actions/runs/40195278314) on `c909106a…` **failed**. Lint "Check unused code" (`vp run knip:check`) reported `T3_CODE_ORCHESTRATION_INSTRUCTIONS` at `packages/provider-core/src/server/orchestrationInstructions.ts:47:14`, and Check and CI Gate then failed. The baseline has no clean Full CI.                           |
| Intel package             | [Run 40195333118](https://github.com/lastobelus/lastCode/actions/runs/40195333118) on `c909106a…` **passed**. This is a separate macOS x64 package workflow, so it does not approve CI or identify the installed app.                                                                                                                                                                 |
| Local batch, Node 24      | 173 of 173 tests passed across 12 files, exit 0, on Node 24.13.1. This is local coverage on a different runtime from CI.                                                                                                                                                                                                                                                              |
| CI-engine repeat, Node 26 | The same 12 files passed again, 173 of 173, exit 0. Runner and workers ran on Node 26.12.1 with Vite+ 1.3.0 and Vitest 5.0.5. This is the same 173 tests twice, not 346 unique tests, and it is focused evidence, not Full CI.                                                                                                                                                        |
| Reviews                   | Astra High and Opus 5.5 High reviewed independently. All nine findings are incorporated: the missing #486 and #487, the CI ordering for #481, runtime identity, the six-caller scope of #475, human scope, and the two-environment and native recipes.                                                                                                                                |
| Preview                   | A provisional source-built dev preview exists for fixture preparation. It is built from this report's documentation commit on top of the baseline, not from repaired source, and it is not acceptance evidence.                                                                                                                                                                       |

Upstream basis for each repair: #475 [`30fd973de3`](https://redirect.github.com/pingdotgg/t3code/commit/30fd973de3eda7e40ea3617baf93bc3f8ac324a9), #476 [`0504c99205`](https://redirect.github.com/pingdotgg/t3code/commit/0504c99205e427ed1a6a571b2d4c4ece910a8a65), #486 [`5d5b6e025c`](https://redirect.github.com/pingdotgg/t3code/commit/5d5b6e025ca4a4d8c9e15ec69d525c1f749fea40), #477 [`c79ef8c454`](https://redirect.github.com/pingdotgg/t3code/commit/c79ef8c454e1268ff79da5a9dcb74572e86f7861), #479 [`550f119c3a`](https://redirect.github.com/pingdotgg/t3code/commit/550f119c3ac12b2df070c4fd545ab8b41222debb), #487 [`133b9b0c72`](https://redirect.github.com/pingdotgg/t3code/commit/133b9b0c72ce859e4c3ac25aec201d22d82a94ee). #481 is a LastCode-only defect.

## Integrated QA

- **One UI preview** is built from the exact merged `lastcode/main` SHA that contains the repairs, and only after their CI is clean. It is labeled **source-built dev preview, not installed 3655**. Record the SHA and CI evidence before attributing repaired behavior to it. It uses isolated state and a managed, retained handoff, and no other previews start for validation.
- **Scripted checks, not people,** prove exactly-once delivery, ordering, permissions, auth renewal, tab isolation, cleanup and transport.
- **Two-environment read:** a second isolated backend, at the same merged SHA, acts as a fixture. It is not a second UI preview. It records real environment IDs, the local direct connection mode, read and next page, reads under captured authority, disconnect and its explicit unavailable receipt, reconnect, missing versus denied, and links returned by the tools. That proves the local seam only. **LAN, relay and tunnel stay unverified.**
- **Native** is out of scope unless a repair needs a native path. #487 is verified by automated fetch; native playback would be a separate result. Mobile workspace adaptation gets its own PR, with `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` before Metro.
- **Human: at most three visual judgments,** deferred (`human_qa=defer`): how Pause and the held Action look, how lineage and sidebar ownership look, and how the retained preview looks after reopening. Each is eligible only after review and clean CI. Deferred is neither a pass nor a waiver of any gate.

---

## Appendix: acceptance details

**Runtime for every command:** Node 26.12.1 first on `PATH`, dependencies prepared through the Prepare Dependencies Action, Vite+ 1.3.0 and Vitest 5.0.5, and no `VITE_HTTP_URL` or `VITE_WS_URL`. Record `node --version`, `vp --version` and the worker runtime. Each run keeps a JSON report (`--reporter=json --outputFile=…`) and its exit record in local evidence, never in commits. The baseline red run uses only the newly ported regression cases plus the test-only diff; after the repair, rerun the whole listed files. Use `Deferred`, `Queue` or a worker drain. No sleeps, polling, per-test timeouts, retries or static-markup tests. If a subprocess fixture hangs under the root config's fake timers, diagnose the runner before calling it a product defect.

### Repair acceptance

- **#481:** Make the symbol private if nothing in LastCode uses it publicly, and leave the instruction text unchanged. LastCode deliberately keeps its `T3_CODE_MCP_INSTRUCTIONS` consumers, while upstream Claude still imports `T3_CODE_ORCHESTRATION_INSTRUCTIONS`. State that difference so checkpoints preserve it. No compatibility export.
- **#475:** `EventSink.ts` uses `Effect.suspend`, so a cancellation after commit can skip publication. Protect the whole sequence after commit (outbox notification, outcomes, committed and live delivery) while keeping work interruptible before commit and lane release correct. Masking a single notification is not enough. The matrix below must pass in `FoundationPersistence.test.ts`, with `DelegatedCompletionDelivery.test.ts` as the parent-delivery seam.
- **#476:** Port upstream's "delivers the run a background command's wake starts after the original result" regression. A single eligibility decision covers both registration and parent locking. Monitor and progress notifications create no tasks. Cover Pause and Resume, archive, independent and promoted children, cancellation, released ownership and concurrent parent activity. Record run IDs, the task identity, the receipt and result counts. Action completion stays its own service.
- **#486:** Using a terminal stub, hold readiness and expect zero writes. Then signal readiness and expect exactly one write and one completion. Cover duplicate signals, open and write failures, cancellation and cleanup. If the update drain activates while the write waits, the write either stays inside admitted work or is rejected; it never starts unaccounted. Keep `terminalLinkProfileName` and service scope. Keep this work separate from lazy preparation and #473.
- **#477:** Cover Plan and Default with MCP `undefined`, `false` and `true`, including Plan→Default on an existing session. Model, effort and service tier persist. Keep LastCode's browser and device context markers and explicit unavailable values. Regenerate LastCode replay fixtures from the real request shape. Only Codex owns Codex modes.
- **#479:** At and around the 120,000-character budget, each accepted file or unresolved path appears as a usable path or an explicit unavailable reference. Captured-window context gets a bounding notice, and delimiters and native images stay intact. Cover multiple attachments, null resolution and Pi's shared helper.
- **#487:** Check relative audio and video against absolute and persisted controls: the signed fetch, MIME type, body and byte ranges, plus malformed and unsatisfiable ranges under the existing contract. Reject tampered tokens, traversal, cross-workspace substitution and symlink escape. Keep the existing authority path for files assistants publish outside the workspace. Automate the draft file-browser fetch.

**#475 callers.** Interrupt before commit: expect rollback and nothing published. Interrupt after commit, before each post-commit step: expect the full chain exactly once. Assert subscriber order, outcome and effect counts, the receipt, lane release, and that the next write proceeds. Also cover a lane-wait cancellation and a transaction failure.

| Caller                           | Accepted path                                                                | Rejection path                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `write` / `writeWithEffects`     | Effects notified, outcomes recorded, committed then live delivery            | Rollback on failure; ownership exclusion publishes nothing                       |
| `writeIfRunCurrent`              | Same                                                                         | Stale run, status or attempt: no events, effects or outcomes                     |
| `writeIfProviderThreadOwner`     | Same                                                                         | Stale attempt or ordinal: nothing published                                      |
| `writeIfProviderThreadUnchanged` | Outcomes, committed and live delivery                                        | Changed snapshot rejects; no outbox notification expected                        |
| `commitCommand`                  | Atomic receipt, events, projections and outbox; signals; both delivery paths | Replay returns the receipt with no duplicates; failure leaves no partial receipt |
| `commitProjectCommand`           | Atomic project event and receipt; `eventStore.publishCommitted`              | Duplicate returns without publication; no live fanout, outcome or outbox         |

### Commands

```sh
# Repairs (run on the baseline red, then on the repair green)
pnpm exec knip --workspace packages/provider-core --exports --preprocessor ./scripts/knip-schemas.ts --no-config-hints  # 481
vp test run apps/server/src/provider/CodexDeveloperInstructions.test.ts                                                 # 481
vp run check:changed origin/lastcode/main                                                                              # every repair
vp test run apps/server/src/orchestration-v2/FoundationPersistence.test.ts apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts  # 475
vp test run apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts apps/server/src/orchestration-v2/EnvironmentPauseQueue.test.ts  # 476
vp test run apps/server/src/project/ProjectSetupScriptRunner.test.ts apps/server/src/orchestration-v2/runtimeLayer.update-drain.test.ts  # 486
vp test run apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts apps/server/src/provider/CodexDeveloperInstructions.test.ts  # 477
vp test run packages/provider-core/src/server/attachmentPrompt.test.ts packages/provider-pi/src/server/adapter.test.ts  # 479
vp test run apps/server/src/assets/AssetAccess.test.ts                                                                  # 487

# B0 (done: 173/173 on Node 24 and on Node 26)
vp test run apps/server/src/mcp/toolkits/core.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/ThreadReadBroker.test.ts apps/server/src/orchestration-v2/EnvironmentPauseQueue.test.ts apps/server/src/orchestration-v2/UsageLimitRecoveryPause.test.ts apps/server/src/actionResume/ActionResume.test.ts apps/server/src/orchestration-v2/pullRequestWatch.test.ts apps/server/src/preview/HostingAuth.test.ts apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts scripts/prepare-dependencies.test.mjs packages/shared/src/dependencyActivity.test.ts

# B1–B8 (not executed)
vp test run apps/server/src/mcp/McpToolAccess.test.ts apps/server/src/mcp/McpToolAccess.race.test.ts apps/server/src/mcp/threadAccess.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/auth/McpOAuth.test.ts apps/server/src/secrets/SecretRequests.test.ts  # B1
vp test run apps/server/src/environment/EnvironmentPause.test.ts apps/server/src/orchestration-v2/Orchestrator.environment-pause.test.ts apps/server/src/actionResume/ActionResume.archive.test.ts apps/server/src/actionResume/ActionRunStore.test.ts apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.test.ts apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts  # B2
vp test run packages/client-runtime/src/connection/threadRead.test.ts apps/server/src/mcp/toolkits/thread/handlers.test.ts apps/server/src/mcp/OrchestratorMcpService.test.ts  # B3
vp test run apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts apps/server/src/orchestration-v2/ThreadFamilyStartupRecovery.integration.test.ts apps/server/src/orchestration-v2/ThreadRecoveryService.test.ts apps/server/src/orchestration-v2/ThreadRecoveryRepairService.test.ts apps/server/src/orchestration-v2/repairHistoricalThreadCreators.test.ts packages/client-runtime/src/state/projectGrouping.test.ts  # B4
vp test run apps/server/src/mcp/toolkits/pullRequests/handlers.test.ts  # B5
vp test run apps/server/src/orchestration-v2/runtimeLayer.test.ts -t 'suspends PR polling while paused|wakes once for a state it reported|finishes owed checks once'  # B5
vp test run apps/server/src/preview/Hosting.test.ts apps/server/src/preview/SessionControl.test.ts apps/server/src/preview/Manager.test.ts apps/server/src/preview/ServerBrowserPage.test.ts apps/server/src/preview/DesktopBrowserChannel.test.ts apps/server/src/mcp/PreviewAutomationBroker.test.ts apps/server/src/mcp/toolkits/preview/handlers.test.ts  # B6
vp test run apps/server/src/workspace/ThreadLinkedFiles.test.ts apps/server/src/preview/PublishedDocumentPreview.integration.test.ts apps/server/src/guest/GuestShareService.test.ts apps/server/src/guest/http.test.ts apps/server/src/guest/guestView.test.ts packages/contracts/src/guestShare.test.ts  # B7
vp test run scripts/build-runner-dependency-use.test.mjs apps/server/src/storageCleanup.test.ts apps/server/src/orchestration-v2/ResourceCleanupService.test.ts apps/server/src/orchestration-v2/WorktreeCleanupService.test.ts apps/server/src/workspace/DependencyMounts.test.ts  # B8
vp test run packages/client-runtime/src/state/dashboard.test.ts packages/contracts/src/orchestration.dashboard.test.ts packages/contracts/src/threadMetadataMcp.test.ts apps/server/src/mcp/toolkits/threadDashboard/handlers.test.ts apps/server/src/orchestration-v2/ThreadArchivePolicy.test.ts apps/server/src/orchestration-v2/ThreadArchiveFamily.query.test.ts apps/server/src/orchestration-v2/ThreadArchiveRestart.integration.test.ts  # B8

# Conditional, run only inside the matching adaptation PR
vp test run apps/server/src/persistence/DatabaseMigrations.test.ts apps/server/src/persistence/initializeV2Database.test.ts apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts  # C1 migrations, if wiring changes
vp test run apps/server/src/orchestration-v2/ShellStream.test.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts apps/server/src/orchestration-v2/ProjectionStore.cleanup-visibility.test.ts packages/client-runtime/src/state/shellReducer.test.ts packages/client-runtime/src/state/threadFamilies.test.ts packages/client-runtime/src/state/dashboard.test.ts  # C2 shelf
vp test run apps/desktop/src/preview/BrowserSession.test.ts apps/desktop/src/preview/BrowserProfileScope.test.ts apps/desktop/src/preview/Manager.test.ts  # C3 desktop browser, if implicated
vp test run scripts/lib/cli-external-packages.test.ts  # C4 toolchain scanner
vp test run apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts apps/server/src/sourceControl/sourceControlDefinitions.test.ts packages/client-runtime/src/sourceControlClients.test.ts  # C5 forge
```

Invoke `vp` as `node node_modules/vite-plus/bin/vp`. For new or refactored web hooks and components, also run the web package's compiled tests and React compiler coverage. A package build is a separately authorized Action.

### What each batch's fixtures must prove

| Batch | Fixture and assertion                                                                                                                                                                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | Read-only OAuth client; restricted discovery and invocation; tools available only to the caller; a wrong or replayed session; the target mode ceiling; Action output owned by another thread; a one-use secret raced twice; redacted errors. What the client shows as available must match what the server allows.                                         |
| B2    | Producers: manual input, PR, scheduled interval and webhook, Action, delegated and native completion, quota reset. Pause → restart → Resume: no automatic starts while held, order unchanged, one continuation per identity, questions kept. Action exit 0, nonzero, cancel, archive and process loss each give one truthful result and keep their output. |
| B3    | Captured authority survives while the parent advances. Refusal stays refusal. A foreign session cannot answer. Replayed, late or mismatched pages are rejected. Missing is distinct from unavailable.                                                                                                                                                      |
| B4    | Root, delegated, native, grouped, promoted and archived families; missing creators; foreign projects. Unknown provider state never becomes a completion. Evidence from a newer turn survives acknowledgment of an older one. Claude background evidence is covered. Inherited options, overrides and clearing stay intact.                                 |
| B5    | Mock checks, comments, reactions, head changes and conflicts. Pause does not advance the cursor. Owed news is delivered once after restart. A child cannot own a watcher. No real PR writes.                                                                                                                                                               |
| B6    | Auth minting tied to the descriptor; denied redirects; a timeout followed by more input; two isolated agent tabs; a human-owned tab that is visible but immutable; no silent host substitution. The 24-hour sleep, kept recipe and reopen run on a controlled clock. A screenshot alone proves none of this.                                               |
| B7    | Authorized published file versus an arbitrary path; the boundary between draft and persisted media; every guest lifecycle state, approval and restriction. Guest credentials never authorize trusted cross-environment reads.                                                                                                                              |
| B8    | Synthetic aged allocations. Active runs, retained preview source and mounts are protected. Unknown ownership is retained. A final read-only revalidation blocks deletion through a rebound path. Dashboard obligations and family consent survive archive and restart. No production cleanup.                                                              |

### Shelf adaptation requirements

The shelf hides only older rows that were **explicitly settled** at the top level. It keeps the newest 25 settlement times, plus ties, and any pinned, snoozed, live or ancestor rows. Counts include rows that those exceptions keep visible.

- Keep the same-sequence `relatedThreads` and `relatedRemovedThreadIds`.
- `familyOf` broadens `subagentFamilyOf`. Archive decisions use server queries.
- Keep open dashboard and Action obligations, and never page through all history to count them.
- Carry `persistent`, `annotation`, `dashboardItems`, `actionResume`, creator, grouping and cleanup fields through decode, the codec, the snapshot, deltas, the cache and rehydrate.
- C2 covers more than 25 settled rows, ties, mixed projects, old rows with open obligations, fork and native children, a deleted row pending cleanup, page and live-update races, and duplicate IDs across environments.
- Publish measured before/after cold JSON bytes.

### Migrations, clients and records

**Migrations:** The `lastcode_sql_migrations` ledger (IDs 1–15) and upstream's `effect_sql_migrations` are separate ledgers, so shared file numbers are not collisions. Upstream added no new persistence migration in this window. Never renumber or drop migrations.

**Client adaptations:** Cover chat, Settings, the command palette, keybindings, desktop menus and deep links, and mobile navigation. Make a supported, unsupported or unchanged decision for each provider: Codex, Claude, Cursor, Grok, OpenCode, Antigravity and ACP/Pi. Keep local, direct remote, relay or tunnel, and native results separate. Validation targets macOS and Linux.

**Records:** The primary owns the canonical ledger. Each result records:

- the source, base and head SHAs
- the exact command
- the runtime
- the fixture
- the expected and actual results
- counts and exit status
- an evidence reference

An existing test or a worker's summary is not executed acceptance. A new failure is classified as environment, product defect or prospective risk. Only a genuinely new defect gets a new issue, after a duplicate search. Each repair closes its issue when it lands. #480 stays the analysis record and carries no production patches.
