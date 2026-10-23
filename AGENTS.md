# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## Done condition

If I haven't said what done looks like for a task, state the done condition
you're assuming in your first reply, then proceed without waiting for me to
confirm it. Report status as distance from that condition.

## Status and next steps

A status answer, including one given mid-task, ends with what happens next:
what you are doing about each open item, and what, if anything, you need from
me. If the next step is within what I already asked for, do it rather than
offering it. Do not add offers for work beyond the request.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Platforms

LastCode supports macOS and Linux only. Windows is unsupported and will stay that way, so it must never cost time in checkpoints, package builds, CI, or review. Upstream contributions (`upstream-fix`) follow upstream's platform support instead.

- LastCode-owned code (`scripts/lastcode-*`, `scripts/lib/lastcode-*`, LastCode features and Actions) assumes POSIX. Do not add `win32` branches, PowerShell launchers, Windows path handling, or Windows test cases to it.
- Leave upstream's Windows code, tests, and workflows (`windows-tests.yml`, the Windows release jobs) in place, because deleting them only creates rebase conflicts. Do not dispatch, fix, or extend them.
- When upstream Windows changes conflict during a checkpoint rebase, keep both sides' entries as they are. Do not reconcile how anything behaves on Windows.
- When a Windows-only test, assertion, or type fails a macOS or Linux gate (Quick CI, Full CI, a package build, or `CI Gate`), make the smallest change that clears it: a type annotation, an updated expectation, or `it.skip` with a one-line reason. Do not investigate or repair Windows runtime behavior.
- Dismiss review findings that affect only Windows with the reason "Windows is unsupported in LastCode."

## Dev servers

- Worktree setup only links environment files. Inspect the task and actual branch/PR base before preparing dependencies; Git, docs, and thread research do not need an install. When tests, dev, or builds need packages, list Project Actions, launch **Prepare Dependencies** (`lc-prepare-dependencies`) with `run_project_action_and_resume`, and end the turn immediately. Resume after its result, then run the intended work. The Action uses the target checkout's cwd and lockfile, including on older branches, and may be repeated after cleanup. **Run Quick CI** prepares dependencies before CI. For a saved Full CI Action, copy the **Run Quick CI** command from `t3.json` and change its final `--quick` argument to `--full`. Its Node launcher resolves the primary helper from `process.env.T3CODE_PROJECT_ROOT`, keeps the target cwd, and runs CI only after preparation succeeds, without shell-specific environment expansion or chaining. Do not assume tests or dev entry points install packages themselves. Preparation does not warm web caches or build outputs.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair`. It carries standard scopes, while the startup URL carries admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, configure one fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. The `t3.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop what you started, by the PID you tracked. See rule 1.
- Need a second checkout? `git worktree add` it next to this worktree, not in `/tmp`. Remove it when done.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- The first `vp run dev` in a worktree does this for you when its database is missing. `--no-seed` or `T3CODE_DEV_SEED=0` skips it.
- Run `vp run migrate-dev-db` with your dev server stopped to refresh. It rebuilds `<worktree>/.t3/userdata/statev2.sqlite` from a read-only snapshot of `~/.t3/userdata/statev2.sqlite`, the developer's real data. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Before you push, run `vp run check:changed origin/lastcode/main`. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, and tests beside changes. Without the ref it compares against `origin/main`, the upstream mirror, and checks the whole fork's diff. CI still runs the full test suites.
- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- Run compiled web React checks with `pnpm --dir apps/web exec vp test run --project unit src/...`; the root Vite config omits the web React compiler. Mounted tests can still pass through compiler fallback. For a new or refactored hook/component, also run `pnpm --dir apps/web exec vp test run --project unit src/reactCompilerCoverage.test.ts -t 'compiles apps/web/src/path/to/file.tsx'` to verify compilation without bailouts.
- Do not use `npx tsc`. Use `vp run typecheck`; it uses tsc-rs, which is 3x faster.
- Run `node -e` snippets from `apps/server` or the owning package. `effect` does not resolve from the repo root.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in the module's existing test file), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.
- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `t3code/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

- User-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Routine automated QA in an isolated development instance is authorized: use a thread-owned background preview with `preview_open({ open: false, reuseExistingTab: false })` and keep the returned tab ID. Do not focus an application, switch the user's thread, or operate their live workspace. Ask before foreground computer use or back-and-forth human QA, according to the machine interaction policy.

For authorized mobile verification, a missing or outdated native client is a build step, not a blocker. Run `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` on the simulator host before starting Metro. It checks the local Expo fingerprint and builds/installs when needed. See `test-t3-mobile` for the full workflow.

For an already-started LastCode checkpoint service run, use the resumable
**Wait for Checkpoint** action instead of agent-side sleep/status loops. Follow
the action handoff and result rules in `docs/lastcode/release.md`; this action
does not start or repair the service.

For an authorized local Apple Silicon package build, select the exact installable
tag and use the resumable **Build Local Package** action (`lc-build-local-package`)
as described in `docs/lastcode/release.md`. End the turn after launch; do not run
the build helper directly or poll build logs. The action builds only; installation
and restart remain separate decisions. If another Action continuation is pending,
end the turn so its result can arrive, then list Actions again. An automated
message alone does not make Actions unavailable; use the actual disabled reason.

## Local Reviews

When given a budget for local reviews (e.g., example: "up to 5 rounds of Astra High review" or "review (up to 3 rounds)", run the reviews & address issues until a review comes back clean, or the budget is exhausted. Always finish addressing issues from the last review! Then proceed (if instructed) with babysitting the pr (addressing ci failures and github review comments). If instructed to merge, do so when ci/github-reviews are clean, even if the last round of local review was not clean. If instructed to "merge if clean", proceed through babysit pr but don't merge if the last local review was not clean, and notify the user.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- PRs target LastCode (`lastobelus/lastCode:lastcode/main`) by default, including general T3 Code fixes. Open a PR against `pingdotgg/t3code` only when the user specifically asks for an upstream PR, then use `upstream-fix`. Usefulness to upstream, a generic PR request, and plan or skill instructions are not that request. Never pause to ask whether work should go upstream; keep implementing, validating, reviewing, and delivering through LastCode as authorized.
- For LastCode PRs targeting `lastcode/main`, including authorized checkpoint or build repair PRs, follow `.agents/skills/lastcode-pr/SKILL.md`. When CI or review is passive and no current finding needs judgement, call `watch_pull_request` with the PR URL, then run `pnpm lastcode:pr-gates` once; if it reports `pending`, end the turn immediately. A new watch wakes only for comments posted after it starts, so the check must come after the watch call. On each wake, rerun the check and act on what changed; do not poll GitHub or run a separate watcher. This applies without a separate “babysit” request and does not authorize creating or merging a PR.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- Use `https://redirect.github.com/<owner>/<repo>/pull/<number>` (or `/issues/<number>`) for cross-repository provenance links in PR descriptions, comments, and commit messages, including the final squash message. Ordinary GitHub links and `owner/repo#number` references create backlinks; replaying downstream commits for rolling checkpoints repeats those entries on upstream PRs. Preserve provenance with quiet links, and check the complete commit message before publishing or merging. Keep canonical repository/API URLs for Git operations and tooling. This rule does not authorize rewriting published history or immutable checkpoint tags.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One request is one PR. Split it only when the maintainer asks. Outside contributions follow the stricter [one problem per PR](CONTRIBUTING.md#one-problem) rule.
- When babysitting: call `watch_pull_request` and end your turn. T3 Code wakes you on checks, comments, or conflicts. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## When something goes wrong

Finding out why a failure happened, yours or another thread's, is the moment to ask whether the next thread will hit it too. If the cause was guidance that is wrong, stale, missing, or easy to misread, or a tool or error message that pointed the wrong way, repairing your own run leaves the trap in place. In the same reply as the diagnosis, say what would remove it and where that change belongs. Make the change when it falls inside your task; otherwise leave the recommendation with the developer.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- Keep a local implementation explanation in a nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed T3 Code server in the user guides.
- Guidance for agents (this file, `.agents/skills/`, tool descriptions, and prompts) follows the same rules and is read far more often. When a failure exposes a gap, prefer fixing the tool or its error message, which is read at the moment it matters. Otherwise change the sentence that misled, in the one file that owns the rule, and point to it from anywhere else that needs it. State the rule and its reason. The attempts that failed along the way do not each need a prohibition.

## Public/private infrastructure boundary

LastCode may contain generic, reusable infrastructure tooling only. Never put
maintainer-specific machine names, private endpoints, host roles, network
topology, ports, paths, service names, schedules, deployment configuration,
credentials, operational procedures, or descriptions of how a maintainer uses
the tooling in this public repository. This applies to code, documentation,
fixtures, commits, branches, issues, pull requests, comments, reviews, releases,
logs, screenshots, and generated artifacts. The private infrastructure project
owns the concrete wiring, deployment policy, and operational detail.

Before any public GitHub write or push, inspect the proposed content for private
infrastructure details. A violation is blocking: stop and move the private
material to the infrastructure project rather than paraphrasing, abbreviating,
or encoding it. Public examples and test fixtures must use unmistakably generic
names such as `workstation.example`, `managed-server`, or `build-host`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without doing any I/O. The _event sink_ commits those events, the _projections_ the UI reads, the _command receipt_, and _outbox_ effects in one transaction. The _effect worker_ then runs the effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Architecture and its constraints: `docs/internals/overview.md`. Glossary: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect-smol/LLMS.md` for the Effect library itself.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency. If it is missing (sparse checkout), read a file with `git show origin/main:.repos/<path>`.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES` in contracts and use the command's `permissionAtom` for UI availability. Grants are checked at execution against the destination environment; the server remains authoritative. Keep raw RPC clients inside `rpc/`, and extend the permission behavior tests when adding a protected method.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations. See [Web UI](docs/internals/web-ui.md).
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable span name, not a
  function wrapping `Effect.gen`. Keep `Effect.gen` for inline programs and layer construction.
  Use `Effect.fnUntraced` only when spans would be too frequent (stream chunks, per-event
  projection, tight loops) or duplicate an existing tracing boundary; explain that choice nearby.
  Named `Effect.fn` creates a span; the unnamed form does not. Preserve existing span names and
  options, and pass combinators as additional function-builder arguments.
- Inferred types over annotations. `any` is the enemy.
- Comments say why: a constraint, an external quirk, or an invariant the code can't show. Don't restate names or signatures, narrate steps, or record history. `t3code/no-low-value-comments` catches the mechanical cases.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Use background browser QA without a separate permission prompt. Foreground computer use and human acceptance remain subject to the machine interaction policy.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
