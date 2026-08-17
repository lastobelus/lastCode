# Intake and Evidence Reference

Use this reference to create a reproducible receipt before executing upstream
PR code and to keep delivery claims tied to exact commits.

## Candidate receipt

Capture PR metadata before fetching or executing the candidate:

```bash
repo=pingdotgg/t3code
pr=<number>

gh pr view "$pr" --repo "$repo" --json \
  number,title,url,state,isDraft,author,baseRefName,baseRefOid,headRefOid,\
  mergeable,mergeStateStatus,changedFiles,statusCheckRollup,\
  reviewDecision,labels,body,closedAt,mergedAt,updatedAt

head_sha=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)
commit_receipt=$(
  gh api --paginate --slurp \
    "repos/$repo/pulls/$pr/commits?per_page=100" |
    jq -c 'flatten | {
      count: length,
      shas: map(.sha),
      final_sha: (last.sha // null)
    }'
)
test "$(printf '%s' "$commit_receipt" | jq -r .final_sha)" = "$head_sha"
printf '%s\n' "$commit_receipt"

git fetch upstream "pull/$pr/head:refs/remotes/upstream/pr/$pr"
git rev-parse "refs/remotes/upstream/pr/$pr"
```

The REST request must use both `--paginate` and `--slurp`; `gh pr view --json
commits` exposes only the first 100 commits. Require the receipt's `count` to
equal the complete flattened result and both `final_sha` and the fetched PR ref
to equal `headRefOid`. Also record:

- observed date and timezone;
- ordered commit SHAs and authors;
- changed file list and diff stat;
- linked issues and claimed behavior;
- all formal reviews and issue comments;
- all review threads, including unresolved and outdated threads;
- upstream check results;
- closure reason or superseding change when closed; and
- current fetched `upstream/main` and `origin/lastcode/main` SHAs.

Use the paginated review and thread queries in
`.agents/skills/_references/external-review-mechanics.md`. Do not infer a clean
candidate from an empty GitHub summary.

## Duplicate and integration checks

Before adoption, compare the candidate against both current destinations:

- ancestor containment answers whether the exact commit exists;
- stable patch IDs help find identical patches with rewritten commits;
- code/search and linked-issue inspection find replacements with different
  implementations;
- path overlap identifies files needing closer review but does not prove a
  conflict;
- a merge-tree preview or the isolated cherry-pick establishes textual
  applicability; and
- source review establishes semantic compatibility.

For multiple commits, preserve the PR API order. Use `git range-diff` when the
candidate head changes or when validating a rebased port.

## Validation receipt

Tie every result to the exact port head and destination base. Record:

- toolchain activation command plus Node and package-manager versions;
- dependency install command and terminal success;
- focused commands and test counts;
- `git diff --check` result;
- affected-surface matrix with explicit non-applicable entries;
- integrated client, disposable-state boundary, viewport, route/state/rendered
  assertions, and before/after artifact paths or published URLs;
- any fallback browser system and the approval that allowed it; and
- clean worktree, local head, remote head, and destination base at publication.

Do not convert missing evidence into a product pass or failure. Mark the
assertion `blocked`, explain the evidence gap, and either obtain authority for a
fallback or hand it off.

## LastCode PR body checklist

Include:

- upstream PR URL, title, author, observed state/date, and pinned head;
- linked issue and LastCode adoption rationale;
- `cherry-pick -x` or reimplementation method;
- conflict resolutions and LastCode-specific adaptations;
- unresolved upstream review or closure context;
- focused and integrated validation; and
- durable GitHub-hosted visual evidence for UI changes.

Before merge, refresh the PR snapshot and require the same exact head across the
clean Codex result, zero unresolved threads, full-CI stamp, and merge command.

After a squash merge, verify stable patch equivalence:

```bash
git diff <port-parent> <port-head> | git patch-id --stable
git diff <base-before-merge> <merged-main> -- <changed-paths...> | git patch-id --stable
```

Matching patch IDs show the validated port became the merged change even though
the original topic commit is not an ancestor of the squashed result.
