---
name: review-pr
description: |
  Review an existing GitHub pull request for this LastCode/T3 Code repository by PR
  number, or the current branch's PR when the user says "review this PR". Runs bounded
  review rounds over correctness, conditional UI/component, KISS, UX, and
  best-practices lenses; applies safe fixes to the PR branch; validates; pushes; and
  summarizes results. Supports `light review-pr`, `heavy review-pr`, and explicit round
  counts.
---

# Review PR Skill

Review and improve an existing GitHub PR.

## Operating Rules

- Resolve PR -> inspect scope -> build context -> run bounded reviews -> synthesize and
  apply safe fixes -> validate -> push -> final handoff.
- If no PR number is provided, resolve the current branch’s PR with `gh pr view`.
- Review the whole PR against its base branch, not only local edits.
- Apply fixes only when they are within PR scope and do not require user/product
  judgement.
- Ask the user only when a finding changes product behavior beyond PR intent, expands
  scope materially, needs protected context, or has multiple plausible user-visible
  fixes.
- Do not simulate external reviews.

## PR Resolution

Collect:

- PR number, URL, title, body, author, base branch, head branch, head SHA, draft state
- changed files, diff stat, name-status
- current check/validation status when available

Fetch the base/head refs. Work in the PR head worktree/branch when possible. If the
current worktree is unrelated or dirty, create a temporary worktree for review/fixes.
Stop if a writable PR-branch worktree is not possible.

Use a freshly fetched remote base ref or exact base SHA. Do not rely on stale local
`main`.

## LastCode/T3 Code Review Lenses

Run rounds in this order:

1. `correctness`: behavior, regressions, contracts, data/state consistency,
   validation gaps.
2. `ui-component`: for `apps/web`, `apps/desktop` UI, `apps/mobile` UI, styles,
   user-facing copy, accessibility, or interaction changes.
3. `KISS`: simplicity, duplicate logic, unnecessary compatibility, avoidable churn.
4. `UX`: visible flows, loading/error/empty states, responsive behavior, manual QA.
5. `best-practices`: main-session review using repo conventions and `ctx7` for current
   docs when library/framework/API details matter.

Use `.agents/skills/_references/external-review-mechanics.md` for external reviewers.

## Validation

After applying fixes, run relevant targeted tests plus required repo checks:

```bash
vp check
vp run typecheck
```

Also run `vp run lint:mobile` for native mobile changes and appropriate `vp test` /
`vp run test` commands for touched packages.

## Synthesis

For each finding:

- `applied`: fix committed.
- `defended`: no code change, but rationale captured in code, tests, docs, or PR notes.
- `rejected`: wrong, duplicate, already covered, or outside PR scope.
- `deferred`: blocked by tooling/quota/validation/protected context/human decision.

Commit accepted fixes with concise messages and push to the PR branch.

## Final Handoff

Include:

- PR link
- review depth and rounds completed
- reviewers/lenses used and skipped
- commits pushed
- validation commands/results
- disposition totals by lens
- remaining deferred findings or human decisions
- manual QA focus or `Manual app QA not run: no manual UI QA surface`

Do not end with a magic-phrase prompt.
