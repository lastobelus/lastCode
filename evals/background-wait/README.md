# Background waits versus Project Actions

This eval compares real LastCode threads for [issue #824](https://github.com/lastobelus/lastCode/issues/824). Both arms run the same fixture workloads on the same server revision. Arm A loads the Action guidance from the landed wrapper commit on `lastcode/main`, opts the fixture Action in, and leaves `lastcodeBackgroundWaitEnabled` off. Arm B loads this branch's `AGENTS.md` and turns the flag on. Agent-facing Project Actions still exist in both arms.

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

Start the dev servers in separate terminals. Use the same `eval_root` value in each terminal. Keep the `a` and `b` variables in the shell running the eval. The source's wrapper flag applies to newly started provider sessions.

```sh
vp run dev:server --home-dir "$a" --no-seed --host 127.0.0.1 --port 44191 --dev-url http://127.0.0.1:45191
```

```sh
vp run dev:server --home-dir "$b" --no-seed --host 127.0.0.1 --port 44192 --dev-url http://127.0.0.1:45192
```

Use `--dry-run` to print the plan. Inspect `problems` in the results if a sample fails.

Run one arm at a time at the same concurrency. The default is 20 fresh threads per case and two active samples at once.

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

To reuse the saved arm A Luna run, start the arm B server from this checkout and choose a new output name. The arm A fixtures and scoring match the saved run. Both arms use that run's exit-code matcher, which can reject reports that bold the exit code. The server revisions differ, so pass the exact saved arm A head to record both revisions.

```sh
node evals/background-wait/run.ts --base-dir "$b" --arm b --model gpt-6-luna --out luna-pr833
node evals/background-wait/compare.ts "$a/background-wait-eval/luna/results.json" "$b/background-wait-eval/luna-pr833/results.json" --baseline-head 7203dc52fc8f208dbebcafc21737241ac9dbfd73
```

For a smoke run, use a separate output name with `--samples 1 --case prepare,quick-ci,standing-watch`. The fixture uses the checked-out wrapper as shipped. The comparison JSON includes `redundantMarksPerWrapperWait`, the number of redundant marks divided by background wait instructions observed.

## Optional Claude comparison

Run this only with an Anthropic API key or the owner's explicit go-ahead to use their Claude subscription. Create fresh Claude homes. For API access, pass `ANTHROPIC_API_KEY` in the shell running each dev server. For authorized subscription use, sign in with `CLAUDE_CONFIG_DIR="$ca/claude-home" claude auth login` and repeat for `$cb`.

```sh
ca="$eval_root/claude-a"
cb="$eval_root/claude-b"
node evals/background-wait/run.ts --base-dir "$ca" --arm a --provider claudeAgent --init
node evals/background-wait/run.ts --base-dir "$cb" --arm b --provider claudeAgent --init
```

Start the two dev servers as above using `$ca` and `$cb` and unused ports. Run the comparison with matching credentials and settings.

```sh
node evals/background-wait/run.ts --base-dir "$ca" --arm a --provider claudeAgent --model claude-haiku-5-5 --out haiku
node evals/background-wait/run.ts --base-dir "$cb" --arm b --provider claudeAgent --model claude-haiku-5-5 --out haiku
node evals/background-wait/compare.ts "$ca/background-wait-eval/haiku/results.json" "$cb/background-wait-eval/haiku/results.json"
```

## Resume

Repeat the same command with the same `--out` name. The runner saves launch intents, accepted thread IDs, observed holds and finished grades as it goes. It reattaches to earlier threads and skips graded samples. If the server never confirms an ambiguous start, the runner stops with that sample's title and preserves the record for inspection. A timeout leaves the thread running and the run resumable. One Ctrl-C lets currently observed samples reach completion or their timeout and stops new launches. After an ungraceful kill, remove only that run's `running.lock` once you confirm the recorded PID has exited, then rerun the same command.

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

When a LastCode thread's main agent backgrounds a simple wrapper command, the grader requires a sampled hold or a recorded continuation that delivered the wrapper result. A short hold can fall between CLI status snapshots. The reported hold count comes from those snapshots. A complete foreground output needs no hold. The zero-polls gate counts only arm B's shell polls between the visible wait instruction and turn end, including `write_stdin` and `TaskOutput`. Other unexpected tool calls still fail the sample. Calls to `t3_background_wait` after the wrapper's line and lookups for that tool count as overhead. Codex rollout files provide the tool sequence and Claude uses SDK tool blocks. The CLI status observer contributes no model requests.

## Cost

- **Primary** is raw input plus output tokens per sample. Input includes cache reads and cache writes. Cached input is a subset, reported separately. Codex uses per-request `last` usage events, deduplicated by provider thread, turn, and cumulative tokens. Claude uses per-result SDK usage totals and distinct begun message IDs, checked against observed assistant request IDs.
- **Standing** is a source-size estimate at four UTF-8 bytes per token. It includes the project guidance, unchanged Action mediation instructions, the relevant tool descriptions and parameter declarations, and the flag-gated Codex background-wait instruction. Claude has the background-wait tool in both arms. The result records each estimate per request and their total across requests. Providers may truncate project guidance or defer tool definitions, so this is an inventory estimate. Do not add it to raw usage. Both arms still include the Action tools and the server's Action instructions. Their deletion savings are outside this experiment.
- **Projected** is the owner's formula, `turns × typical context size when called + increased context × typical subsequent turns`. Turns are mean observed thread-family turns. Context size is the median first request input tokens in arm A for the same model and effort. Increased context is the median change from first to last request input in the initiating thread. This is a proxy that includes task dialogue as well as wait overhead. `--subsequent-turns` defaults to a scenario value of **5** and the report shows 0, 1, 5 and 10. Historical subsequent-turn counts were unavailable. Supply a measured value if available.
- LastCode's 30-day sample had **1,388** agent-launched Actions, **84%** from Codex. The four short operations had medians of **0.3–2.6 minutes** and checkpoint waits had a **43-minute** median. The default fixtures deliberately compress the longest wait and sample the six workloads equally. They cannot support a production-weighted monthly estimate without counts by operation, a measured subsequent-turn distribution, and representative thread depths.

A full comparison for one model and effort starts 240 samples plus the Quick CI workers. With two active samples at once, the scripts alone take about 72 minutes per arm/model at default durations, before agent and dev startup overhead. External waits, provider startup behavior, real builds, the 30-minute boundary, restart, and the effect of Claude's longer foreground timeout on unrelated commands need separate evidence. Changing the wait lengths with `--duration-scale` creates a separate comparison. A 20-sample gate is an observed count comparison and small differences are uncertain.

The `mcp-tool-use` simulator remains useful for testing tool-choice text and mock result handling. It cannot establish provider tool visibility, actual hold transitions, post-instruction shell polls, or real request cost.

Use `vp test run --project root evals/background-wait/run.test.ts` for the offline parser and grader tests. The runner's `--dry-run` runs without a server, provider or existing base directory.
