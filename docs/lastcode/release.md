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
The checkpoint runner is the narrow exception: after a checkpoint or revision
candidate passes its dedicated smoke gate, its immutable tag and subsequent
`lastcode/main` promotion push with `--no-verify`. This avoids rerunning the
workspace suite from the automation checkout and prevents GitHub from closing an
idle SSH connection while the hook runs. Exact upstream `main` mirroring also
uses `--no-verify` because it pushes the unchanged upstream commit. Without a
smoke result or published tag, promotion retains the quick pre-push gate and
refuses to proceed unless the invoking checkout is the exact candidate commit
that hook will validate.
pnpm lastcode:merge
checkpoint-daemon run when that service is installed on the current host. Hosts
without the optional service skip the request silently. The daemon publishes a
new installable LastCode revision when no new upstream
nightly is waiting. Failure to start the service is reported without lying about
the already-completed GitHub merge; the managed checkpoint service remains the
repair path. The request never terminates a daemon run already in progress.
pnpm lastcode:intel-stage stage --maximum-version-host version-source.example
`--maximum-version-host version-source.example` reads
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
