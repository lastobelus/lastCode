---
name: review-plan
description: |
  Review a LastCode/T3 Code plan file before implementation. Runs bounded review
  rounds over basic correctness, best-practices, KISS, and conditional UI/component
  lenses; updates the plan in place; and stops when review types are quiet or the
  requested depth is exhausted. Use when the user says "review plan", "review-plan",
  "review the plan at PLAN_FILE", or invokes this skill on a plan file. The plan file path
  is the primary input.
---

# Review Plan Skill

Review a plan file for this T3 Code / LastCode repository.

## Operating Rules

- Run the workflow in one pass. Do not stop between review rounds unless a real blocker
  appears.
- Never require a magic phrase from the user. Any affirmative reply means continue.
- Maintain a one-paragraph running state summary: plan path, review depth, current
  round/lens, quiet/open lenses, and material plan changes.
- Do not simulate external reviews. If external reviewers cannot run after diagnosis,
  report exactly what failed and what you tried.
- Do not let stale exploratory docs override the current plan. Use
  `references/context-hygiene.md` when prior notes, option docs, or ELI5 docs exist.

## Review Depth

- `light review-plan` or `one round`: run exactly one full round.
- `heavy review-plan`: use the default round budget and high reasoning for later
  external review steps.
- `N rounds`: run at most N full rounds.
- Default: up to 3 rounds, stopping earlier when all applicable lenses are quiet.

## LastCode/T3 Code Context

- Repo checks are `vp check` and `vp run typecheck`.
- Use `vp test` for Vite+ tests and `vp run test` when a package script specifically
  matters.
- Run `vp run lint:mobile` only when native mobile code changes.
- Use `ctx7` for current docs when reviewing library/framework/API/CLI-specific plan
  claims.
- Important package roles:
  - `apps/server`: Node WebSocket/provider orchestration server.
  - `apps/web`: React/Vite UI.
  - `apps/desktop`: Electron shell and updater.
  - `apps/mobile`: React Native mobile app.
  - `packages/contracts`: schema-only shared contracts.
  - `packages/shared`: runtime utilities with explicit subpath exports.

## Before Reviewing

1. Read the plan and `AGENTS.md`.
2. Build a focused context file list: the plan, directly relevant docs, contracts,
   tests, and source files. Keep it tight.
3. If the plan touches protected context, summarize the contract instead of exposing
   raw protected files.
4. Decide whether the plan is UI/component-affecting. Use the UI lens for changes to
   `apps/web`, `apps/desktop` UI, `apps/mobile` UI, shared UI components, styles,
   accessibility, interaction states, or user-facing copy.

## Review Lenses

Run lenses in this order:

1. `basic`: scope, acceptance criteria, sequencing, missing validation, risky unknowns.
2. `ui-component`: only when applicable; component reuse, visual states, responsive
   behavior, accessibility, and expected browser/app inspection.
3. `best-practices`: repository conventions, Effect usage, contracts package boundaries,
   provider/runtime reliability, current docs via `ctx7` when relevant.
4. `KISS`: simpler architecture, duplicate logic, unnecessary compatibility layers,
   YAGNI, migration churn.

Use `.agents/skills/_references/external-review-mechanics.md` for reviewer commands and
JSON expectations.

## Acting On Findings

For each finding:

- `applied`: update the plan.
- `defended`: keep the approach but add concrete rationale, constraints, or validation.
- `deferred`: only when blocked by missing user input, unavailable tooling, or exhausted
  review budget.

Mark a lens quiet when its latest review is clean or causes only trivial wording
changes. Reopen quiet lenses when another lens causes material scope, architecture,
validation, or UX changes.

## Final Handoff

Summarize:

- plan path
- requested depth and rounds used
- review lenses run and skipped
- applied/defended/deferred counts
- final quiet/open state
- whether the plan is ready for `implement-plan`
