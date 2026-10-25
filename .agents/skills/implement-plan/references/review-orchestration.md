# Implementation Review Orchestration

Use real reviews only. Do not simulate reviewer output.

## Review Depth

- `light implement-plan`: one round.
- `heavy implement-plan`: up to three rounds, high reasoning for later external reviews.
- explicit `N rounds`: at most N rounds.
- default: up to three rounds, stopping earlier when all lenses are quiet.

## Lenses

Run in order:

1. `correctness`: behavior, contracts, regressions, missing tests, acceptance criteria.
2. `ui-component`: only for UI/component/style/interaction/copy changes.
3. `KISS`: simplicity, duplication, unnecessary compatibility, needless surface area.
4. `UX`: user-facing flows, states, responsiveness, accessibility, manual QA gaps.
5. `best-practices`: main-session review using repo knowledge and `ctx7` for relevant
   current library/framework/API docs.

Use `.agents/skills/_references/external-review-mechanics.md` for reviewer invocation.

## Context For Reviewers

Include:

- plan file
- touched files
- focused diffs from `git diff --stat` and `git diff --name-status`
- validation summary
- relevant docs/contracts/tests
- protected-context summaries, not raw secrets

External reviewers are read-only and must not run repo validation commands.

## Acting On Findings

- Apply findings that improve the implementation within plan scope.
- Defend findings that are wrong, duplicate, already covered, or intentionally out of
  scope by clarifying code, tests, docs, or plan notes.
- Defer only when blocked by tooling, quota, validation, protected context, or a human
  decision.
- Rerun focused validation after material fixes.
- Mark a lens quiet when clean or only insignificant findings remain.
- Reopen quiet lenses when later changes materially affect their concern area.
