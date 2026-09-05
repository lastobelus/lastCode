# LastCode Local Release Workflow

LastCode uses a local waste-prevention gate, GitHub-hosted pull-request CI, and
ad-hoc macOS releases. The GitHub-hosted packaging path is manually dispatched
for an exact Intel checkpoint or revision; releases have no schedule.

Nightly source tracking is documented separately in
[Nightly Checkpoint Workflow](nightly-workflow.md).

## Pull Request CI

Ordinary branch pushes run the quick gate through `.vite-hooks/pre-push`:

```bash
pnpm lastcode:ci:quick
```

Quick CI is a local waste-prevention gate, not merge authority. It checks the
exact branch diff for whitespace errors, repository formatting and lint, and
workspace types. The implementing agent runs focused tests for changed behavior;
GitHub CI retains comprehensive tests,
Electron setup, builds, Rust, native analysis, and release smoke coverage.

Agents run the independent **Run Quick CI** Project Action before a push. A
successful action records the exact head and the selected workstream base ref and
commit: `upstream/main` for upstream `fix/*` and `feat/*` branches, or
`origin/lastcode/main` for LastCode branches. The pre-push hook consumes that
receipt without rerunning validation.

LastCode setup reconciles non-setup Actions from `t3.json` through the
event-sourced project command path. The checkpoint supervisor repeats the
reconciliation after every successful primary `lastcode/main` refresh, including
an already-current refresh. A separately managed checkout can opt into the same
behavior; after a checkout update, it refreshes dependencies before invoking
the checked-in reconciliation code. Ownership state is keyed by workspace so
multiple managed checkouts can share one T3 home. Each reconciled declaration
has an explicit stable `id`, so renaming
its command entrypoint does not change ownership. Exact legacy imports are
adopted without changing their saved Action IDs, so
keybindings and local resume permission survive. Managed name, command, icon,
and preview changes propagate only while the saved Action still matches its last
managed specification; a locally diverged or removed declaration is retained
and reported instead of being overwritten or deleted. A managed resume grant is
revoked while an Action's executable fields are locally diverged.

New Actions remain unavailable to agents until the environment grants trust.
Setup accepts repeated `--trusted-project-action <lc-id>` flags and saves that
allowlist for subsequent checkpoint-supervisor refreshes. Managed checkout
configuration uses `projectActions.trustedActionIds`. Removing a managed trust
entry revokes only that managed grant; permissions enabled directly in Project
Settings remain local user state.

The action never pushes: after it resumes, the agent still decides whether and
what to push. A changed head, changed base tracking ref, or dirty worktree makes
the receipt unusable. Without a matching receipt, ordinary command-line pushes
run Quick CI synchronously and record one for transport retries of the same
commit.

The checkpoint runner is the narrow exception: after a checkpoint or revision
candidate passes its dedicated smoke gate, its immutable tag and subsequent
`lastcode/main` promotion push with `--no-verify`. This avoids rerunning the
workspace suite from the automation checkout and prevents GitHub from closing an
idle SSH connection while the hook runs. Exact upstream `main` mirroring also
uses `--no-verify` because it pushes the unchanged upstream commit. Without a
smoke result or published tag, promotion retains the quick pre-push gate and
refuses to proceed unless the invoking checkout is the exact candidate commit
that hook will validate.

### Repository integrity guards

Local CI has three independent Git-safety boundaries:

1. The pre-push hook clears every repository-local environment variable listed
   by `git rev-parse --local-env-vars` before invoking the package runner. This
   prevents Git's hook-only `GIT_DIR`, `GIT_WORK_TREE`, index, object, shallow,
   and replacement-ref paths from leaking into nested commands.
2. Every child process started by the LastCode CI runner receives the same
   repository-local environment cleanup. Repository tests also receive a
   disposable global Git config, so fixture identities and defaults cannot be
   written into the shared repository config.
3. Before quick or full CI starts, the runner requires `core.bare=false` in the
   shared Git config and snapshots its repository-wide settings. It checks the
   value, protected settings, and common Git directory again on every exit,
   including failed CI runs. Any protected change fails the gate with the config
   path to inspect. Existing per-branch settings are preserved too, while new
   branch keys are allowed because T3 and GitHub CLI legitimately add
   branch/worktree bookkeeping while CI runs in another worktree.

These guards protect the primary checkout and every linked worktree, which all
share the same Git config. They specifically prevent temporary-repository tests
from reinitializing or reconfiguring the real repository when CI is launched by
a Git hook. They do not automatically repair an integrity failure: stop, inspect
the reported config and worktree state, and preserve evidence before changing
anything.

Workspace test tasks run one package, one Vitest worker, and one concurrent test
case at a time. This takes longer than the task-runner defaults but avoids
cross-suite state leaks plus memory and CPU contention between the web, mobile,
desktop, and server suites on whichever CI node runs the gate.

The independent **Wait for PR** Project Action waits for both Codex review and
the exact GitHub pull-request workflow run. GitHub CI records the PR number,
head, base, and synthetic merge commit in the workflow run identity and exposes
one stable aggregate `CI Gate`. Head or base drift invalidates the result and
requires the agent to decide whether to rebase, republish, and request review
again.

This applies to authorized repair PRs opened during checkpoint or build recovery,
without a separate request to babysit. After handling existing findings, call
`list_project_actions`, select the eligible **Wait for PR** action (prefer
`lc-wait-for-pr`), call `run_project_action_and_resume`, and end the turn.
Executing `scripts/lastcode-wait-for-pr.ts` directly in a shell keeps the agent
turn open and defeats the quota-saving handoff. On resume, inspect the result
and recheck the current revision before continuing.

Merge the current ready PR with:

```bash
pnpm lastcode:merge
```

The merge wrapper refuses dirty worktrees, missing or stale exact GitHub CI,
stale bases, draft or non-clean PRs, and PRs that do not target
`lastcode/main`. It fetches and checks the base again after reading CI, then
squash-merges with an exact-head guard and requests an immediate
checkpoint-daemon run when that service is installed on the current host. Hosts
without the optional service skip the request silently. The daemon publishes a
new installable LastCode revision when no new upstream
nightly is waiting. Failure to start the service is reported without lying about
the already-completed GitHub merge; the managed checkpoint service remains the
repair path. The request never terminates a daemon run already in progress.

## Checkpoint CI

### Waiting for the checkpoint service

After an authorized service run has started, use the independent **Wait for
Checkpoint** Project Action (`lc-wait-for-checkpoint`) to observe its completion.
List Actions, launch the eligible returned ID with
`run_project_action_and_resume`, and end the turn immediately. Do not poll
`launchctl`, processes, dashboard output, or log tails while it runs.

The action observes the active local macOS checkpoint service. It does not start
a checkpoint, rebuild, recover, install, or restart anything. It captures the
active process and launch count, waits for it to finish, and reports the terminal
state whose recorded supervisor PID matches that process. A result written while
the supervisor is still delivering notifications is accepted after exit. The
installed supervisor must include this PID field. A missing active run,
unavailable service, replaced run, missing matching
result, or one-hour timeout requires attention; an old success is not proof of
the requested checkpoint. Cancelling the action leaves the service running.
After resume, inspect the result and use `lastcode-checkpoints --verbose` once
for the concrete next recovery or verification step.

The importable declaration is in `t3.json`. As with the PR action, the owning
environment must import it and grant resume permission. Managed installations
use the `lc-wait-for-checkpoint` trust entry. The command loads from
`T3CODE_PROJECT_ROOT`, so an older maintenance-thread worktree can use the
updated observer after the primary checkout is refreshed. If the action is missing or
disabled, report that setup problem rather than reverting to a sleep loop.

### Validating a checkpoint

A release build uses a different full-CI context because rebasing intentionally
rewrites ancestry. Check out the immutable checkpoint or revision and run:

```bash
pnpm run lastcode:ci -- --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

The resulting stamp binds the exact LastCode commit, installable tag, upstream
tag, and upstream commit. A PR stamp cannot authorize a checkpoint build, and a
checkpoint stamp cannot authorize a PR merge.

## Apple Silicon DMG builder

An Apple Silicon DMG builder builds the selected checkpoint or revision:

```bash
pnpm lastcode:build:mac:arm64 \
  --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

The wrapper requires:

- a clean worktree;
- `HEAD` equal to the annotated checkpoint or revision target;
- a valid full checkpoint-CI stamp; and
- a new, non-overwriting output directory.

The app bundle is sealed with Electron Builder's ad-hoc identity, so the bundle
and its resources pass macOS code-signature verification without an Apple
Developer certificate. It is not notarized for public distribution.

Local builds omit the hosted update feed. The built-in updater remains disabled
until LastCode intentionally publishes compatible releases.

## Intel DMG build publication

The resumable **Build Intel package (macOS)** Project Action dispatches the manual
**LastCode Intel artifact** workflow for one exact
`lastcode/checkpoint/...` or `lastcode/revision/...` tag and its full advertised
commit. It rejects moving refs and tag/commit mismatches, runs the checkpoint's
full CI gate on `macos-15-intel`, and builds a certificate-free x64 artifact.

The agent chooses the target explicitly. First record and verify that exact remote
tag in the current worktree:

```bash
pnpm lastcode:intel-build select \
  --tag lastcode/revision/v0.0.34-nightly.20260825.1185.3
```

Then run the imported **Build Intel package (macOS)** Project Action. The
LastCode environment hosting the project and Action terminal must run on macOS;
the connected client may run anywhere, and that environment need not be an Intel
builder. The actual x64 build runs on GitHub's hosted Intel runner. For
agent-triggered
one-shot continuation, enable **Allow Codex and Claude to run and resume** on that
Action in Project Settings. The Action attaches a unique request token to the
dispatch, waits for only the matching workflow run, and returns to the thread on
success, workflow failure or cancellation, missing workflow configuration, or a
run-registration timeout. It reports both the workflow-run URL and immutable
release URL.

The request is marked before dispatch so an interrupted or ambiguous transport
result is never dispatched a second time. The Action waits for the unique token
to appear and then records the matching run ID for later reattachment. If GitHub
never registers it, select the tag again to create a deliberate new request.

The Action only builds and publishes. It never stages, installs, promotes,
restarts, or updates an Intel artifact-consumer node. Those remain separate
agent decisions.

Successful output is attached to the installable tag as a GitHub prerelease,
explicitly excluded from GitHub's latest-release selection. The release contains
the complete build-manifest asset set, `build-manifest.json`, and `SHA256SUMS`.
Before publishing, and again after downloading the published assets, automation
requires the manifest's x64/macOS architecture, exact tag and commit, byte
counts, checksums, and asset set to agree.

Repository **Settings → Releases → Immutable releases** must be enabled before
dispatch. Enabling and checking that setting is an explicit maintainer action
because GitHub's workflow token cannot read the administration-only endpoint;
the workflow never changes repository policy. Every reused or newly published
release must report itself immutable, so a release created before the repository
policy was enabled fails closed.

The Intel build job has read-only repository access. It transfers the validated
asset set to a fresh publication job, which revalidates the assets and tag before
receiving write access; target-controlled build steps never share that token.

A rerun for a complete matching release exits successfully before dependency
installation, CI, or packaging. An existing draft, non-prerelease, partial,
foreign, or mismatched asset set fails closed. Automation never clobbers or
deletes an exact-tag release. Recovery from a partial or conflicting publication
therefore requires a maintainer decision rather than silently changing an
immutable artifact.

The agent-facing action remains explicitly selected. A separate daily GitHub
workflow resolves the newest immutable installable tag, then uses the same exact
tag, commit, request-token dispatch, and release validation path. If that Intel
release already exists, the artifact workflow validates and reuses it without
rebuilding. Installation remains a separate artifact-consumer decision.

### Intel artifact-consumer staging

An Intel artifact-consumer node can fetch the newest published immutable
prerelease without stopping LastCode:

```bash
pnpm lastcode:intel-stage stage
pnpm lastcode:intel-stage stage --maximum-version-host version-source.example
pnpm lastcode:intel-stage status
```

The staging command accepts only exact checkpoint or revision releases newer
than the installed app. It resolves the tag through GitHub to a full commit,
downloads the exact release asset set, and checks the x64/macOS manifest,
release metadata, SHA-256, LastCode bundle ID and version, ad-hoc signature,
and x86_64 main executable. A fully checked newer candidate atomically becomes
the sole pending selection. A cross-process, kernel-released lock serializes
checks and supersession; a mismatch, competing invocation, or interrupted check
leaves the prior pending selection intact. Staging never closes admission, stops
the app, or starts installation.

`--maximum-version-host version-source.example` reads
`/Applications/LastCode.app` on a separately selected version-source node and
stages only releases at or below that installed nightly. A version source may
also be a GUI/controller or server node, but staging does not require that
topology. If SSH is unavailable or the remote version is not a LastCode
nightly, staging stops before changing the current pending selection.
The SSH read is non-interactive and requires key-based access; it never opens a
password prompt.

### Deployment primitives

This repository provides narrow components that private or organization-owned
infrastructure can compose:

- `lastcode:intel-stage` validates and prepares a published Intel build without
  activating it;
- `lastcode:headless-service` runs the packaged server in a dedicated macOS x64
  environment;
- `lastcode:install` performs the guarded application swap and rollback; and
- `lastcode:managed-checkout` aligns an explicitly automation-owned checkout
  with a configured remote branch.

The public contracts use these independent roles:

- **GUI/controller node**: runs a LastCode client and may dispatch Project
  Actions;
- **server node**: runs the LastCode server, either from the desktop app or the
  packaged headless service;
- **Apple Silicon DMG builder** and **Intel DMG builder**: produce artifacts for
  one architecture;
- **artifact-consumer node**: stages or installs an architecture-compatible
  artifact;
- **version-source node**: advertises the maximum installed nightly another
  consumer may select;
- **checkpoint/release coordinator**: tracks upstream nightlies, publishes
  immutable tags, and promotes downstream revisions; and
- **automation-owned checkout node**: exposes a checkout that infrastructure is
  explicitly allowed to synchronize.

One node may perform several roles, or every role may run on a separate node.
The repository deliberately does not choose that topology, an update schedule,
service ordering, or concrete environment paths. Infrastructure code owns those
decisions, including when to pause work, how to select a version ceiling, when
to activate a staged app, and which checkout is reserved for automation.

The managed-checkout tool accepts an absolute JSON configuration:

```json
{
  "backupRefPrefix": "refs/example/managed-checkout-backups",
  "branch": "lastcode/main",
  "gitCommonDirectory": "/srv/example/repository.git",
  "projectActions": {
    "baseDir": "/srv/example/t3-home",
    "trustedActionIds": []
  },
  "remote": "origin",
  "remoteBranch": "lastcode/main",
  "worktree": "/srv/example/managed-checkout"
}
```

Run it with:

```bash
pnpm lastcode:managed-checkout sync --config /absolute/path/checkout.json
```

The tool verifies the configured repository identity, selected branch, clean
tracked and untracked state, inactive Git operation, initialized-submodule
changes, and collisions with ignored content. It fetches only the configured
remote branch, saves the old tip under the configured backup-ref prefix, and
moves the branch with compare-and-swap semantics before updating the tree. The
caller must give it exclusive ownership of the checkout for the duration of the
operation; Git cannot lock arbitrary concurrent filesystem writes. If the ref
moves but tree verification fails, the tool retains the target ref and reports
the backup ref for explicit recovery instead of pretending it rolled back.

The optional `projectActions` block is accepted only when the managed branch is
`lastcode/main`. After a successful refresh—including an already-current
refresh—the tool verifies the LastCode anchor and reconciles its checked-in
Actions into the selected T3 home. The configuration file is the explicit
environment-local management and trust boundary; deployment infrastructure
owns its concrete location and values.

On an Intel artifact-consumer node, state defaults to
`~/.lastcode/intel-updates`. `pending.json` is the narrow,
credential-free handoff contract for later drain and activation work. It names
the immutable tag and commit, expected version and DMG hash, and one candidate
directory. GitHub credentials remain owned by `gh` and are not written into
candidate metadata. `--home-dir`, `--repository`, `--current-version`, and
`--maximum-version-host` are available for isolated validation and recovery
work.

## Runtime Identity

LastCode can run alongside T3 Code and T3 Code Nightly because it owns separate
runtime resources:

| Resource         | LastCode                    | T3 Code                 |
| ---------------- | --------------------------- | ----------------------- |
| Product          | `LastCode`                  | `T3 Code`               |
| Bundle ID        | `codes.lastobelus.lastcode` | `com.t3tools.t3code`    |
| Electron profile | `lastcode` / `lastcode-dev` | `t3code` / `t3code-dev` |
| State home       | `~/.lastcode`               | `~/.t3`                 |
| URL schemes      | `lastcode`, `lastcode-dev`  | `t3code`, `t3code-dev`  |

The profile split also separates Chromium storage and the Electron
single-instance lock. Provider credentials remain in provider-owned locations,
such as `~/.codex`, so they do not need to be duplicated.

Tailscale Serve is machine-global. Do not configure both applications to claim
the same Serve port simultaneously.

## In-App Local Updates

The default-off local updater is documented in
[Local Nightly Updates](local-nightly-updates.md). It discovers immutable
checkpoint and LastCode revision tags, builds a selected tag in a separate
dedicated worktree, and retains the validated DMG for the managed local
installer. It does not stage the updater ZIP through Electron/Squirrel.
Checkpoint scheduling remains independent:
the daemon never builds merely because it found a new nightly or revision.

## Remote update drain admission

An active remote update drain closes only entry points that can create new
execution: turn starts (including provider bootstrap or resume), terminal
creation and restart, terminal writes, and interrupted Action resume. Existing
read-only terminal attachment, terminal close, turn interruption, approvals,
and user-input responses remain available so current work can settle.

Drain status reports only current execution blockers: starting or running
thread work, background agent work, and starting terminals or terminals with a
running subprocess. When that list is empty, the activation claim is committed
under the same server-lifetime admission lock. The claim survives a server
restart and keeps admission closed for the future activation helper.
