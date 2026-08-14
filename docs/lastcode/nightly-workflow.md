# Nightly Checkpoint Workflow

## Objectives

The workflow has four independent requirements:

1. Track upstream T3 Code nightly tags.
2. Rebase the complete LastCode patch stack rather than merge upstream history.
3. Preserve an immutable LastCode checkpoint for every upstream nightly,
   including nightlies that are never packaged.
4. Build only when a checkpoint is intentionally selected and has passed full
   local CI.

Separating checkpointing from building keeps routine upstream tracking cheap and
makes every artifact traceable to exact source.

## References

| Reference                           | Purpose                                                  | Mutability                    |
| ----------------------------------- | -------------------------------------------------------- | ----------------------------- |
| `upstream/main`                     | Canonical T3 Code development branch                     | Moves upstream                |
| `main`                              | Clean local mirror used for upstream contributions       | Fast-forward only             |
| `lastcode/main`                     | Latest promoted LastCode checkpoint and LastCode PR base | Rebased with force-with-lease |
| `lastcode/checkpoint/<nightly-tag>` | LastCode source rebased onto one upstream nightly        | Immutable                     |
| `lastcode/build/<nightly-tag>.<n>`  | One local build attempt from a checkpoint                | Immutable                     |
| `sync/nightly/<nightly-tag>`        | Recovery branch retained after a failed sync             | Temporary                     |

Example tags:

```text
lastcode/checkpoint/v0.0.34-nightly.20260812.1072
lastcode/build/v0.0.34-nightly.20260812.1072.1
```

The upstream nightly tag names remain owned by upstream. The namespaced
LastCode tags record the rebased downstream state and never move.

## Checkpointing

Preview the operation:

```bash
pnpm run lastcode:checkpoint -- --dry-run
```

Run it and publish checkpoint tags:

```bash
pnpm run lastcode:checkpoint -- \
  --push-tags \
  --promote-if-no-open-prs \
  --mirror-upstream-main
```

The command:

1. fetches upstream tags and the fork's existing checkpoint tags;
2. identifies every missing nightly newer than the current downstream base;
3. creates an initial checkpoint for the current base when bootstrapping;
4. processes missing nightlies oldest-first in a dedicated Git worktree;
5. rebases with Git `rerere` enabled so recurring resolutions can be reused;
6. installs dependencies and runs the checkpoint smoke gate;
7. creates and optionally pushes one annotated checkpoint tag per nightly; and
8. optionally promotes the newest checkpoint to `lastcode/main`.

The smoke gate checks fork identity invariants, `git diff --check`, focused
LastCode tests, desktop protocol tests, and the scripts workspace typecheck. It
is intentionally smaller than the full build gate.

Checkpoint-tag publication uses `git push --no-verify` after that dedicated
smoke gate passes. This avoids rerunning the generic repository-wide pre-push
gate for every immutable tag while catching up across multiple nightlies.
Ordinary branch pushes and promotion of `lastcode/main` still run the pre-push
quick gate. If checkpoint smoke is disabled, tag publication is allowed only
when the invoking checkout is already at the checkpoint commit, so that fallback
gate cannot validate the wrong revision.

### Promotion and open PRs

`--promote-if-no-open-prs` keeps `lastcode/main` stable while any PR targeting it
is open. Checkpoint tags are still created and pushed, so PR activity cannot
cause a nightly to be missed. A later scheduled run promotes the newest
checkpoint after the PR queue is empty.

Promotion uses an exact `--force-with-lease` value. It refuses to overwrite a
remote branch that changed after the job fetched it.

Checkpoint metadata records the exact `lastcode/main` source commit used for a
rebase. If publication succeeds but promotion fails, a later run recognizes the
published checkpoint as belonging to the unchanged source commit and retries
promotion instead of treating the older main branch as current.

Use `--promote` only when intentionally overriding the open-PR safeguard.

### Failure recovery

If rebase or smoke validation fails, the command stops at that nightly and
retains both:

- `sync/nightly/<nightly-tag>`; and
- the printed `lastcode-nightly-sync` worktree path.

It also posts a macOS notification. Resolve the rebase or failure in that
worktree, then decide whether to finish and tag it or abandon the sync attempt.
The next automated run refuses to replace an existing recovery worktree.

No later nightly is checkpointed after a failure, because each failure should be
understood before the sequence continues.

## Local Scheduling

Install the per-user launch agent:

```bash
pnpm lastcode:checkpoint:service install
```

The job runs at login and hourly while the Mac is awake. Missed intervals do not
matter: every run discovers all uncheckpointed tags and catches up oldest-first.
When the latest checkpoint is already promoted, the job exits without running
the local push gate or pushing an unchanged branch.
The job executes:

```bash
pnpm run lastcode:checkpoint -- \
  --push-tags \
  --promote-if-no-open-prs \
  --mirror-upstream-main
```

The scheduled job also keeps the fork's clean `main` branch synchronized with
`upstream/main`. This is a guarded remote mirror, not a checkout operation: it
never moves or rewrites a human worktree's local `main` branch. The mirror only
advances when the fork branch is an ancestor of upstream, and pushes with an
exact force-with-lease value. If the fork's `main` has diverged, checkpointing
stops and reports the divergence instead of overwriting either history.

Operational commands:

```bash
pnpm lastcode:checkpoint:service status
pnpm lastcode:checkpoint:service run-now
pnpm lastcode:checkpoint:service uninstall
```

### Checkpoint dashboard

Install the launch agent first so its dedicated automation worktree exists, then
install the checkpoint dashboard as a user command:

```bash
pnpm lastcode:checkpoint:service install
pnpm run lastcode:checkpoints -- --install
```

The installer puts the executable at `~/.lastcode/bin/lastcode-checkpoints`
and exposes it through the existing `~/.local/bin` PATH directory. It records
the dedicated automation worktree in `~/.lastcode/dashboard.json`, so the
command works from any directory without depending on a human development
worktree. Installation fails instead of recording the current checkout when the
automation worktree is missing. The installed launcher uses the repository's
pinned Node 24 runtime through `mise`, independent of the shell's default Node.

Show the latest eight checkpoint activities, or choose another count:

```bash
lastcode-checkpoints
lastcode-checkpoints -n 20
```

The dashboard shows success or failure, upstream nightly, number of downstream
commits replayed, finish time, duration, checkpoint commit, promotion to
`lastcode/main`, and whether a local build tag exists. It also summarizes the
launch agent and whether the local checkpoint set has caught up to the latest
known upstream tag. Failed rows include the retained recovery branch and error.

Successful checkpoint metadata is stored in the annotated checkpoint tag, so
it travels with the Git repository. Failed and successful local attempts are
also appended to `~/.lastcode/automation/checkpoint-runs.jsonl`. Checkpoints
created before dashboard metadata was introduced infer the replayed commit
count and finish time from Git; their duration is shown as `—`.

If publishing a newly created tag fails, the job removes its local copy so a
later run can retry it, and cleans up the completed temporary rebase worktree.
Before planning any pushed run, the job also removes checkpoint tags that exist
only locally; this recovers bootstrap attempts whose first cleanup was blocked.
Failures during the rebase or smoke gate still retain their recovery worktree.
A local tag deletion failure is recorded explicitly (and retains recovery state
when a worktree exists), preventing that local tag from being displayed as a
published checkpoint.
A checkpoint tag fetched from the fork is authoritative over a failed local run
record: this reconciles the case where the remote accepted a push but the client
lost its acknowledgement or an operator manually completed recovery. The
dashboard verifies checkpoint publication against `origin`; while offline, an
unconfirmed local tag with a failed run remains failed rather than being shown
as current. The bounded remote probe also reads `lastcode/main` for the `MAIN`
column and falls back to the cached branch ref if the remote does not respond.

Interactive output uses the amber, ice, pacific, lavender, success, warning,
and error palette from the shell `mocolors` theme. Redirected output, `NO_COLOR`,
and `TERM=dumb` produce plain text.

Logs are written to `~/.lastcode/automation/`. Uninstalling unloads the job and
moves its plist to a timestamped disabled backup instead of deleting it.
The installer creates a dedicated `lastcode-automation` Git worktree. Before
loading the launch agent, it installs that worktree's dependencies. Before each
scheduled run, the worktree fetches and force-checks out
`origin/lastcode/main`, reconciles its dependencies from the checked-out lockfile,
and then runs the checkpoint command. It never uses or modifies a human
development worktree. Uninstall leaves the automation worktree available for
inspection.

When a new nightly needs an isolated sync worktree, dependency bootstrap uses
the automation worktree's installed Vite+ runner. Once installation completes,
all smoke checks use the sync worktree's own runner. This keeps scheduled runs
independent of shell PATH configuration and global `vp` installations.

The launch agent is opt-in. Repository installation and tests never register it.

## Selecting a Build

For routine use, install the userland build command beside the checkpoint
dashboard:

```bash
pnpm run lastcode:build -- --install
```

The installer places the versioned command under `~/.lastcode/bin` and exposes
it through the dotfiles-managed `~/.local/bin` PATH. With no selector, it builds
the newest local checkpoint. The final nightly sequence number is accepted as
shorthand when selecting an older checkpoint:

```bash
lastcode-build
lastcode-build 1090
lastcode-build --checkpoint 1090
```

`1090` is a **checkpoint selector**: it resolves to the unique immutable
`lastcode/checkpoint/*-nightly.*.1090` tag. A full upstream nightly tag or full
checkpoint tag is also accepted. The command uses the same dedicated worktree,
full local CI, immutable artifact directory, and DMG/ZIP builder as the in-app
local updater. During a build it shows the latest log line above a stage-weighted
estimated progress bar; the complete output remains in
`~/.lastcode/local-updates/build.log`. Completed builds are reused.

For lower-level or diagnostic use, check out the desired checkpoint, run full
checkpoint CI, then build that same tag:

```bash
git switch --detach lastcode/checkpoint/v0.0.34-nightly.20260812.1072
pnpm run lastcode:ci -- --checkpoint lastcode/checkpoint/v0.0.34-nightly.20260812.1072
pnpm run lastcode:build:mac:arm64 -- \
  --checkpoint lastcode/checkpoint/v0.0.34-nightly.20260812.1072
```

The build refuses a dirty worktree, a mismatched HEAD, a missing checkpoint CI
stamp, or an existing output directory. Fetching a newer upstream tag cannot
change the selected version.

Output is grouped by upstream nightly and LastCode commit:

```text
release-lastcode/
  v0.0.34-nightly.20260812.1072/
    <lastcode-short-sha>/
      LastCode-0.0.34-nightly.20260812.1072-arm64.dmg
      LastCode-0.0.34-nightly.20260812.1072-arm64.zip
      build-manifest.json
      SHA256SUMS
```

`build-manifest.json` records the checkpoint tag, upstream tag and commit,
LastCode commit, build tag, build time, platform, architecture, artifact sizes,
SHA-256 hashes, and the local signing identity when one was used. `SHA256SUMS`
provides a conventional verification file.

### Stable local signing

Ad-hoc signing works without an Apple account, but each rebuild has a different
code identity. macOS can therefore ask for Keychain access again after an
update. For stable personal builds, create a free **Apple Development**
certificate with Xcode's Personal Team, then configure the userland builder:

```bash
lastcode-build --setup-signing
lastcode-build --signing-status
```

If the Mac has multiple eligible identities, choose the one printed by the
setup error:

```bash
lastcode-build --setup-signing --signing-identity <40-character-hash>
```

The selected identity is recorded by hash and name in
`~/.lastcode/local-signing.json` with user-only permissions. It is not a
certificate or private key; those remain in the login Keychain. Later builds
pass the stable identity to Electron Builder. If no configuration exists,
LastCode deliberately retains the ad-hoc fallback. A previously completed
ad-hoc artifact is not reused after persistent signing is enabled; it is
quarantined and rebuilt so the requested checkpoint actually has the selected
identity.

Creating an Apple Development certificate through a Personal Team does not
require the paid Apple Developer Program. It does require signing into Xcode
once, and Personal Team certificates and provisioning assets may expire and
need renewal.

The build creates a local annotated `lastcode/build/...` tag. Pass `--push-tag`
only when that build record should be published to the fork.

## GitHub Rules

Configure the fork so that:

- checkpoint and build tags cannot be modified or deleted;
- only the owner or automation identity can force-push `lastcode/main`;
- ordinary LastCode changes arrive through PRs targeting `lastcode/main`; and
- GitHub Actions remain disabled while local CI is authoritative.

Branch protection must permit the intentional force-with-lease promotion model.
If GitHub cannot express that narrowly enough for a personal repository, rely on
repository ownership plus the checkpoint command's lease check rather than a
rule that makes promotion impossible.
