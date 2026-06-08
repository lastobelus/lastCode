# External Review Mechanics

Use this reference when a project skill invokes read-only external reviewers. The owning
skill defines review order, budgets, quiet/reopen rules, and what to do with findings.

## Reviewer Availability

- Prefer real external reviewers. Do not simulate reviewer output.
- Available local reviewer commands may include `codex` and `opencode`.
- If `ai-limit-checker` is available, run it before expensive review rounds and avoid
  providers whose quota is clearly exhausted.
- If no eligible reviewer can run after checking binary presence, auth/session state,
  cwd, flags, and prompt piping, stop and report the blocker.

## Protected Context

- Scan prompts, plans, PR bodies, diffs, and context lists for protected files:
  `.env*`, auth stores, key files, local tool-state artifacts, private tokens, and
  credentials.
- Do not point reviewers at raw protected files, including checked-in env fixtures.
- Provide sanitized excerpts when a contract matters, and prefer tests/docs that encode
  the same behavior without secrets.

## Prompt Shape

Build the reviewer prompt in memory. Include:

- workflow name and review lens
- current branch/PR/plan identifiers
- base and head refs when reviewing a PR or implementation diff
- focused context file list
- diff stat and name-status when reviewing code
- validation summary, if available
- explicit read-only instruction
- finding cap for the current round

Ask for exactly one JSON object, with no markdown fences:

```json
{
  "summary": "short summary",
  "overall_status": "clean | has-findings",
  "findings": [
    {
      "severity": "high | medium | low",
      "title": "short title",
      "details": "specific actionable explanation",
      "references": ["path:line or doc reference"],
      "evidence_basis": [
        "plan_file | context_files | repo_diff | validation_summary | docs_research"
      ]
    }
  ],
  "residual_risks": ["risk that remains after review"],
  "repo_validation_ran": false,
  "forbidden_commands": []
}
```

Reviewers may inspect files and diffs. They must not run repo validation, lint, typecheck,
build, test, package, install, migration, server, browser, or release commands.

## Command Patterns

Codex read-only review:

```sh
printf '%s\n' "$PROMPT" | codex --search --disable fast_mode -a never exec -m gpt-5 -c 'model_reasoning_effort="medium"' -s read-only -C "$PWD" -
```

Use `model_reasoning_effort="high"` for heavy mode, correctness-heavy reviews, round 3+,
or high-risk implementation concerns.

Opencode review, when configured:

```sh
opencode run -m zai-coding-plan/glm-5.1 "$PROMPT"
```

## Session Handling

- Record the review command, reviewer, model, review lens, and start time.
- After starting a long review, do not treat elapsed time alone as failure. Reviews can
  reasonably take several minutes.
- Investigate only when the command exits, streams an explicit error, appears to wait
  for auth/approval, or produces no progress after a long wait.
- If output is malformed, first try to extract one unambiguous schema-valid JSON object.
  Retry once only when extraction is impossible or ambiguous.
- If a reviewer ran forbidden commands, ignore command-derived evidence, salvage
  file/diff/doc-based findings, and tighten the next prompt.
