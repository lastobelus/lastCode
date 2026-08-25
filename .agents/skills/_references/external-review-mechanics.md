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

## GitHub Review State

Use GitHub's current head SHA as the review boundary. Do not infer a clean review
from elapsed time, an empty `reviewDecision`, a checkmark, or a review attached to
an older commit.

Start with one PR snapshot:

```sh
gh pr view "$PR_NUMBER" --repo "$OWNER/$REPO" \
  --json url,state,isDraft,headRefOid,baseRefOid,mergeStateStatus,reviewDecision,statusCheckRollup
```

Read every formal review and issue comment, not only GitHub's default page:

```sh
gh api --paginate --slurp \
  "repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews?per_page=100"
gh api --paginate --slurp \
  "repos/$OWNER/$REPO/issues/$PR_NUMBER/comments?per_page=100"
```

For a Codex trigger comment, inspect its reactions when the review result is not
explicit in a current-head review body. A current Codex eye reaction means review
is still running; a thumbs-up can be the terminal clean signal:

```sh
gh api --paginate --slurp \
  -H 'Accept: application/vnd.github+json' \
  "repos/$OWNER/$REPO/issues/comments/$COMMENT_ID/reactions?per_page=100"
```

Accept Codex as clean only when its result was produced after the latest relevant
push, identifies the exact `headRefOid` (for a formal review, its `commit_id`
matches), and gives an explicit no-issues result or terminal clean reaction. A
generic review wrapper, silence, or absence of inline findings is insufficient by
itself. After a push, request review once unless a current request is already
active. Bind the request to the full current head SHA using exactly these two
lines so resumable PR actions can distinguish it from an older request:

```text
@codex review
<!-- lastcode-review-head: HEAD_SHA -->
```

Read all review threads with GraphQL pagination. `gh api --paginate` supplies the
next `$endCursor`; keep `pageInfo` in the query so it cannot silently truncate at
100 threads:

```sh
gh api graphql --paginate --slurp \
  -F owner="$OWNER" -F repo="$REPO" -F number="$PR_NUMBER" \
  -f query='query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        headRefOid
        reviewThreads(first:100, after:$endCursor) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first:100) {
              nodes { id body path line createdAt author { login } }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }'
```

If a thread's nested `comments.pageInfo.hasNextPage` is true, query that thread's
comments separately with `node(id:$threadId)` and the same paginated connection
pattern before deciding what the thread says.

Reply with concrete evidence before resolving an addressed or disproved finding:

```sh
gh api graphql \
  -F threadId="$THREAD_ID" -F body="$REPLY" \
  -f query='mutation($threadId:ID!, $body:String!) {
    addPullRequestReviewThreadReply(input:{
      pullRequestReviewThreadId:$threadId,
      body:$body
    }) { comment { id } }
  }'

gh api graphql \
  -F threadId="$THREAD_ID" \
  -f query='mutation($threadId:ID!) {
    resolveReviewThread(input:{threadId:$threadId}) {
      thread { id isResolved }
    }
  }'
```

Before merge, take a fresh snapshot and require all of these on the same head:

- terminal-clean Codex result;
- zero unresolved review threads, including outdated threads;
- required checks and local validation are green;
- mergeability is clean and the expected base SHA has not moved.

After any fix push or rebase, discard the prior review conclusion and repeat the
current-head gate.
