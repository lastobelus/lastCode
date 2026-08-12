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
pnpm lastcode:checkpoint --dry-run
```

Run it and publish checkpoint tags:

```bash
pnpm lastcode:checkpoint --push-tags --promote-if-no-open-prs
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

### Promotion and open PRs

`--promote-if-no-open-prs` keeps `lastcode/main` stable while any PR targeting it
is open. Checkpoint tags are still created and pushed, so PR activity cannot
cause a nightly to be missed. A later scheduled run promotes the newest
checkpoint after the PR queue is empty.

Promotion uses an exact `--force-with-lease` value. It refuses to overwrite a
remote branch that changed after the job fetched it.

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
pnpm lastcode:checkpoint --push-tags --promote-if-no-open-prs
```

Operational commands:

```bash
pnpm lastcode:checkpoint:service status
pnpm lastcode:checkpoint:service run-now
pnpm lastcode:checkpoint:service uninstall
```

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

Check out the desired checkpoint, run full checkpoint CI, then build that same
tag:

```bash
git switch --detach lastcode/checkpoint/v0.0.34-nightly.20260812.1072
pnpm lastcode:ci --checkpoint lastcode/checkpoint/v0.0.34-nightly.20260812.1072
pnpm lastcode:build:mac:arm64 \
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
and SHA-256 hashes. `SHA256SUMS` provides a conventional verification file.

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
