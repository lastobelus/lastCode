# LastCode Documentation

LastCode is a personal downstream of T3 Code that rebases its complete fork-only
patch stack onto upstream nightly releases. Tracking an upstream nightly and
building an application are deliberately separate operations: every nightly can
be checkpointed, while only selected checkpoints need full local CI and a build.

This directory is the deliberate namespace for LastCode-only contributor and
operations documentation. Product documentation and material intended for an
upstream contribution continue to use T3 Code's audience-based documentation
directories.

## Documents

- [Nightly workflow](nightly-workflow.md): checkpoint tags, rebasing, promotion,
  scheduling, recovery, and provenance.
- [Release workflow](release.md): local CI, PR merging, ad-hoc signing, builds,
  and runtime isolation.
- [Contribution and fork conventions](fork-conventions.md): the two workstreams,
  contribution bases, paired upstream/LastCode changes, remotes, branches, and
  evaluation tags.
- [Local nightly updates](local-nightly-updates.md): the opt-in in-app
  checkpoint build, staging, installation, safety boundaries, and logs.

## Command Summary

```bash
# Inspect what the checkpoint job would do.
pnpm lastcode:checkpoint --dry-run

# Checkpoint every missing nightly and push immutable tags.
pnpm lastcode:checkpoint --push-tags --promote-if-no-open-prs

# Enable the same operation at login and hourly.
pnpm lastcode:checkpoint:service install

# Install and inspect the checkpoint dashboard (eight rows by default).
pnpm lastcode:checkpoints --install
lastcode-checkpoints
lastcode-checkpoints -n 20

# Validate and build one explicit checkpoint.
pnpm lastcode:ci --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
pnpm lastcode:build:mac:arm64 --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

None of the checkpoint commands builds an application. An opted-in packaged
desktop app can build a selected checkpoint locally from its sidebar update
button; no build is uploaded or published.
