# LastCode Documentation

LastCode is a personal downstream of T3 Code that rebases its complete fork-only
patch stack onto upstream nightly releases. Tracking an upstream nightly and
building an application are deliberately separate operations: every nightly can
be checkpointed, while only selected checkpoints need full local CI and a build.

## Documents

- [Nightly workflow](nightly-workflow.md): checkpoint tags, rebasing, promotion,
  scheduling, recovery, and provenance.
- [Release workflow](release.md): local CI, PR merging, ad-hoc signing, builds,
  and runtime isolation.
- [Fork conventions](fork-conventions.md): remotes, branch intent, upstream pull
  requests, alternate forks, and evaluation tags.

## Command Summary

```bash
# Inspect what the checkpoint job would do.
pnpm lastcode:checkpoint --dry-run

# Checkpoint every missing nightly and push immutable tags.
pnpm lastcode:checkpoint --push-tags --promote-if-no-open-prs

# Enable the same operation at login and hourly.
pnpm lastcode:checkpoint:service install

# Validate and build one explicit checkpoint.
pnpm lastcode:ci --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
pnpm lastcode:build:mac:arm64 --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

None of the checkpoint commands builds an application. No build is uploaded or
published unless a separate explicit release operation is added later.
