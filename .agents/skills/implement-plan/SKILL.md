---
name: implement-plan
description: |
  Implement a reviewed LastCode/T3 Code plan file end to end: code the plan, keep the
  plan/docs aligned, validate with repo checks, run bounded implementation reviews,
  perform cleanup, and hand off concrete results. Supports `light implement-plan`,
  `heavy implement-plan`, and explicit round counts. Use when the user says
  "implement plan", "implement-plan", "ship the plan at PLAN_FILE", or "build the plan".
  The primary input is the plan file path.
---

# Implement Plan Skill

Implement a reviewed plan in this repository.

## Operating Rules

- Complete the workflow in one run: inspect plan -> implement -> validate -> review ->
  cleanup -> handoff.
- Stop only for real blockers: ambiguous branch/worktree, unsafe rebase/conflicts,
  scope expansion that needs a new plan, unavailable reviewers after diagnosis,
  validation failure you cannot fix, or a user/product decision.
- Never require a magic phrase. Any affirmative response means continue.
- Dirty unrelated files are reportable, not blocking, unless they directly block edits
  or validation.
- Maintain a one-paragraph running state summary at phase boundaries.

## Start Conditions

1. Read the plan and `AGENTS.md`.
2. Confirm branch intent:
   - upstream contribution work should branch from `main` / `upstream/main`
   - LastCode-private work should branch from `lastcode/main`
3. Fetch relevant remotes before rebasing.
4. Rebase only when the target branch is unambiguous and the worktree is clean enough.
5. Treat the plan as source of truth. Use
   `references/source-of-truth-guard.md` when older artifacts may be discoverable.

## Implementation Rules

- Follow existing repo patterns before introducing abstractions.
- Keep `packages/contracts` schema-only.
- Avoid compatibility layers unless the plan or user explicitly requires them.
- Use Effect service/process/path/schema APIs where the repo’s diagnostics require
  them; do not bypass Effect diagnostics in new scripts unless the boundary truly
  needs a local suppression.
- For frontend work, follow the project’s dense app UI style and verify with browser
  inspection when the change is visual or interactive.
- Update docs, plan notes, and validation sections as implementation reality changes.

## Validation

Required before completion:

```bash
vp check
vp run typecheck
```

Also run:

- targeted `vp test ...` or package tests for touched areas
- `vp run test` when the package script is specifically needed
- `vp run lint:mobile` for native mobile changes
- local build/smoke commands named by the plan

Do not move past a failed validation step unless you fix it and rerun, or stop and
report the blocker.

## Review And Cleanup

Use `references/review-orchestration.md` for implementation review rounds. Run at least
one review round unless the user explicitly asks for implementation only.

After review rounds:

- do a cleanup pass for duplication, boundaries, stale comments, docs, and tests
- update the plan’s validation/results sections
- commit/push when the user’s workflow calls for it

## Final Handoff

Use `references/handoff-and-manual-qa.md`. Include changed files, validation results,
review depth/rounds, commits pushed, remaining risks, and manual QA steps.
