# Background waits versus Project Actions

This eval compares real LastCode threads for [issue #824](https://github.com/lastobelus/lastCode/issues/824). Both arms run the same fixture workloads with the same saved Actions on the same server revision. Arm A loads the Action guidance from the landed wrapper commit on `lastcode/main` and leaves `lastcodeBackgroundWaitEnabled` off. Arm B loads this branch's `AGENTS.md` and turns the flag on. The flag hides agent-facing Action launch tools and their launch and mediation guidance. Action recovery tools remain available.

## Run on Codex

Run from the repository root at the same committed head for both arms, with dependencies prepared and the repository's pinned Node on PATH. Use fresh directories outside the source checkout. These commands create two empty development homes with isolated Codex configuration. Codex is the default, and these homes have Claude disabled. The runner checks the marker, expects a live loopback dev server, and keeps fixtures, worktrees, logs and results beneath the selected home.

```sh
eval_root="$(mktemp -d "${TMPDIR:-/tmp}/lc-wait-eval.XXXXXX")"
a="$eval_root/arm-a"
b="$eval_root/arm-b"
node evals/background-wait/run.ts --base-dir "$a" --arm a --init
node evals/background-wait/run.ts --base-dir "$b" --arm b --init
CODEX_HOME="$a/codex-home" codex login
CODEX_HOME="$b/codex-home" codex login
```

Use the same Codex account and backend for both arms. Keep native session persistence enabled and use matching provider settings in the two homes.

If the servers already run from another checkout, set `LASTCODE_EVAL_SERVER_CLI` to that checkout's absolute `apps/server/src/bin.ts` path. The CLI must match the running server's database schema. The runner records the supplied path in the results.

Start the dev servers in separate terminals. Use the same `eval_root` value in each terminal. Keep the `a` and `b` variables in the shell running the eval. The source's wrapper flag applies to newly started provider sessions.

```sh
vp run dev:server --home-dir "$a" --no-seed --host 127.0.0.1 --port 44191 --dev-url http://127.0.0.1:45191
```

```sh
vp run dev:server --home-dir "$b" --no-seed --host 127.0.0.1 --port 44192 --dev-url http://127.0.0.1:45192
```

Use `--dry-run` to print the plan. Inspect `problems` in the results if a sample fails.

Run paired arms at the same concurrency. The default is 20 fresh threads per case and two active samples at once. Before launching each sample, the runner saves its opted-in Action in that project's settings through the running server and checks the effective Action. This also works in homes that have migrated their legacy project settings. Each arm verifies its live tool catalog in a separate Codex thread before the samples start. The probe's requests stay outside the sample costs and its instructions stay out of the task prompts. A catalog mismatch, missing catalog evidence, or Action launch in arm B makes the comparison incomplete.

```sh
node evals/background-wait/run.ts --base-dir "$a" --arm a --model gpt-6-luna --out luna
node evals/background-wait/run.ts --base-dir "$b" --arm b --model gpt-6-luna --out luna
node evals/background-wait/compare.ts "$a/background-wait-eval/luna/results.json" "$b/background-wait-eval/luna/results.json"
```

After Luna passes, set `higher_model` to the Codex model selected for the higher-effort runs. Run each approved effort with a fresh matching output name. This example stops the ladder at the first failure.

```sh
for effort in medium high xhigh; do
  out="codex-$effort"
  node evals/background-wait/run.ts --base-dir "$a" --arm a --model "$higher_model" --effort "$effort" --out "$out" &&
  node evals/background-wait/run.ts --base-dir "$b" --arm b --model "$higher_model" --effort "$effort" --out "$out" &&
  node evals/background-wait/compare.ts "$a/background-wait-eval/$out/results.json" "$b/background-wait-eval/$out/results.json" ||
  break
done
```

The comparison reports one model and effort at a time. The codified pass bar is 20 complete samples per arm in each of the six cases, a majority of correct wrapper samples and at least as many correct samples as Actions **in each case**, zero post-instruction wrapper polls, and lower mean raw tokens per task across the six cases. The report includes per-case raw costs to expose any regressions hidden by the aggregate. A missing trace or missing usage makes the decision incomplete. A valid failure counts, including its measured tokens. The live break tests and soak in #824 remain separate gates.

To compare runs from different revisions, use results scored by the same rubric and pass arm A's exact recorded head. The comparison reads the saved grades as written. Earlier runs that rejected Markdown formatting around exit codes need an offline regrade before comparison with the corrected rubric.

Use paired runs with the same fixtures and prompts for the token and reliability gates. Runs that put the catalog check in the task prompt include its costs and any effect it had on agent behavior. Keep those results as historical evidence and use fresh outputs in both arms for the separate-probe comparison. The standing-watch fixture puts its recipe first so Codex's instruction file limit preserves it in both arms.

```sh
node evals/background-wait/compare.ts "$a_results" "$b_results" --baseline-head "$a_head"
```

For a smoke run, use a separate output name with `--samples 1 --case prepare,quick-ci,standing-watch`. The fixture uses the checked-out wrapper as shipped. The comparison JSON includes `redundantMarksPerWrapperWait`, the number of redundant marks divided by background wait instructions observed.

## Claude samples launched through T3

Use `delegate_task` from an orchestrator in the authorized destination. Run the fixture and grading commands from one committed checkout. Set `server_home` to the destination's T3 data directory, `fixtures_root` to an existing directory outside it, and `worktrees_root` to the destination's worktree directory. Set `results_file` to a file in an existing directory outside the server home. Use one file per arm, model and effort.

```sh
node evals/background-wait/make-fixture.ts \
  --server-home "$server_home" --workspace "$fixtures_root/$sample_name" \
  --arm "$arm" --case "$case_id" --model "$model"
```

Register the returned workspace as a temporary project in T3 and save the returned Action with agent resume enabled in both arms. Launch the returned prompt via `delegate_task` in that project's shared checkout. Quick CI's prompt asks the sample agent to create its own isolated worker. Use a fresh sample thread with `lastcodeBackgroundWaitEnabled` off in arm A and on in arm B. Retain the sample's thread ID, project ID, workspace, trace logs, and worktree until it is graded.

```sh
node evals/background-wait/grade-sample.ts \
  --server-home "$server_home" --thread-id "$thread_id" --project-id "$project_id" \
  --workspace "$fixtures_root/$sample_name" --fixtures-root "$fixtures_root" \
  --worktrees-root "$worktrees_root" --arm "$arm" --case "$case_id" \
  --provider claudeAgent --model "$model" --results "$results_file" --timeout-seconds 900
```

Pass the same `--effort` and `--duration-scale` to both commands when applicable. The grader reads SQLite and native provider logs. It waits for 12 seconds of quiescence and appends each thread once. Holds come from observed status during grading, retained armed or delivered Actions, and wrapper result wakes. Missing hold evidence remains unknown where a wait was expected. Wall time starts at the first run's recorded start. The compare command takes the two external result files in A, B order. A missing catalog, tool trace, token count or required wrapper wake evidence leaves the comparison incomplete. The grader accepts `--provider codex` for inspecting saved isolated runs. Those grades have no separate tool-catalog proof. External result files compare with other external result files.

## Resume

Repeat the same command with the same `--out` name and source revision. The runner saves launch intents, accepted thread IDs, observed holds and finished grades as it goes. It reuses the verified catalog probe, reattaches to earlier threads and skips graded samples. If the server never confirms an ambiguous start, the runner stops with that sample's title and preserves the record for inspection. A timeout leaves the thread running and the run resumable. Ctrl-C or SIGTERM stops new launches and drains samples already being observed. The runner exits nonzero if any requested samples still lack a grade and reports how many to resume. After an ungraceful kill, remove only that run's `running.lock` once you confirm the recorded PID has exited, then rerun the same command.

## Cases and evidence

| Case                            | Seconds per script | Required result                                                                                                                |
| ------------------------------- | -----------------: | ------------------------------------------------------------------------------------------------------------------------------ |
| Prepare dependencies            |                  8 | Pass the fast path and report the generated ID and exit code.                                                                  |
| Prepare checkpoint dependencies |                 45 | Use the requested upstream SHA and report the result.                                                                          |
| Quick CI                        |                 65 | One owned worker in an isolated checkout, one completed child result returned to the parent, and accurate reporting of exit 3. |
| Wait for checkpoint             |                120 | Wait for the active service fixture and report its result.                                                                     |
| Build package                   |                 55 | Use the exact tag and report the generated ID, exit code and artifact.                                                         |
| Standing watch                  |             45 × 3 | Act on two milestone batches in order and relaunch after each acknowledgement. Report the drained queue result.                |

A fresh synthetic Git project and random result IDs distinguish genuine completion from an early or guessed reply. The wrapper fixture uses the production wrapper implementation and argument parser, with dependency-free operations substituted under the real script names. The Action uses the same operations and production structured-report emitter. The standing watch uses the existing `wait-checkpoint` command slot in its own isolated fixture because the server only marks supported wrapper invocations. The baseline explicitly names its one saved Action, and the delegated baseline is authorized to own it in this isolated environment. That gives Actions a favorable comparison against production workflows involving parent-mediated handoff. A like-for-like mediated baseline would need to provision and verify an opted-in Action targeting each worker's newly created worktree, then record the parent's result relay and the child's follow-up. Reusing the parent's checkout would change the case. The matrix covers child-owned Actions and leaves the cost and reliability of mediation unmeasured.

The runner observes the thread state independently of the model. Wall time runs from dispatch intent to the family's last recorded run completion. The delegated case finds the worker from the local app-owned task record and sums both threads' turns and tokens. Quick CI exits 3 in both arms. The Action puts the result ID on stdout because failed Actions omit their structured report from the wake.

When a LastCode thread's main agent backgrounds a wrapper command, the grader requires a sampled hold or a recorded continuation that delivered the wrapper result. The server can also mark a chain of literal simple commands joined by `&&` or `;` when the wrapper is the final step. The fixture uses the shipped wrapper line, which remains unchanged. A short hold can fall between CLI status snapshots. The reported hold count comes from those snapshots. A complete foreground output needs no hold. The zero-polls gate counts only arm B's shell polls between the visible wait instruction and turn end, including `write_stdin` and `TaskOutput`. Other unexpected tool calls still fail the sample. Calls to `t3_background_wait` after the wrapper's line and lookups for that tool count as overhead. Codex rollout files provide the tool sequence and Claude uses SDK tool blocks. The CLI status observer contributes no model requests.

## Cost

- **Primary** is raw input plus output tokens per sample. Input includes cache reads and cache writes. Cached input is a subset, reported separately. Codex uses per-request `last` usage events, deduplicated by provider thread, turn, and cumulative tokens. Claude uses per-result SDK usage and distinct request starts. The standard SDK's `usage` covers the main agent of each app-owned thread and excludes provider-native subagents and auxiliary calls.
- **Standing** is a source-size estimate at four UTF-8 bytes per token. It includes fixture guidance, the server's Action-related launch, handoff or availability text, the visible Action and wait tool descriptions and advertised input schemas, and the flag-gated Codex background-wait instruction. Personal instructions and skills are outside this estimate. The result records each estimate per request and its total across requests. Providers may truncate project guidance or defer tool definitions, so this is an inventory estimate. Do not add it to raw usage.
- **Projected** is the owner's formula, `turns × typical context size when called + increased context × typical subsequent turns`. Turns are mean observed thread-family turns. Context size is the median first request input tokens in arm A for the same model and effort. Increased context is the median change from first to last request input in the initiating thread. This is a proxy that includes task dialogue as well as wait overhead. `--subsequent-turns` defaults to a scenario value of **5** and the report shows 0, 1, 5 and 10. Historical subsequent-turn counts were unavailable. Supply a measured value if available.
- LastCode's 30-day sample had **1,388** agent-launched Actions, **84%** from Codex. The four short operations had medians of **0.3–2.6 minutes** and checkpoint waits had a **43-minute** median. The default fixtures deliberately compress the longest wait and sample the six workloads equally. They cannot support a production-weighted monthly estimate without counts by operation, a measured subsequent-turn distribution, and representative thread depths.

A full comparison for one model and effort starts 240 samples plus the Quick CI workers. With two active samples at once, the scripts alone take about 72 minutes per arm/model at default durations, before agent and dev startup overhead. External waits, provider startup behavior, real builds, the 30-minute boundary, restart, and the effect of Claude's longer foreground timeout on unrelated commands need separate evidence. Changing the wait lengths with `--duration-scale` creates a separate comparison. A 20-sample gate is an observed count comparison and small differences are uncertain.

The `mcp-tool-use` simulator remains useful for testing tool-choice text and mock result handling. It cannot establish provider tool visibility, actual hold transitions, post-instruction shell polls, or real request cost.

Use `vp test run --project root evals/background-wait/run.test.ts` for the offline parser and grader tests. The runner's `--dry-run` runs without a server, provider or existing base directory.
