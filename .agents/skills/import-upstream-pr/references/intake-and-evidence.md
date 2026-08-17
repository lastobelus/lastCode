# Intake and Evidence Reference

Use this reference to create a reproducible receipt before executing upstream
PR code and to keep delivery claims tied to exact commits.

## Candidate receipt

Capture PR metadata before fetching or executing the candidate:

```bash
set -e

repo=pingdotgg/t3code
pr=<number>

metadata=$(gh pr view "$pr" --repo "$repo" --json \
  number,title,url,state,isDraft,author,baseRefName,baseRefOid,headRefOid,\
  mergeable,mergeStateStatus,changedFiles,statusCheckRollup,\
  reviewDecision,labels,body,closedAt,mergedAt,updatedAt)

printf '%s\n' "$metadata"
base_ref=$(printf '%s' "$metadata" | jq -r .baseRefName)
base_sha=$(printf '%s' "$metadata" | jq -r .baseRefOid)
head_sha=$(printf '%s' "$metadata" | jq -r .headRefOid)

git fetch upstream \
  "+refs/heads/${base_ref}:refs/remotes/upstream/${base_ref}" \
  "+refs/pull/$pr/head:refs/remotes/upstream/pr/$pr"

fetched_base=$(git rev-parse "refs/remotes/upstream/$base_ref")
fetched_head=$(git rev-parse "refs/remotes/upstream/pr/$pr")
git cat-file -e "$base_sha^{commit}" || {
  printf 'missing pinned base commit: %s\n' "$base_sha" >&2
  exit 1
}
test "$fetched_head" = "$head_sha" || {
  printf 'PR head changed while pinning: expected %s, fetched %s\n' \
    "$head_sha" "$fetched_head" >&2
  exit 1
}

commit_count=$(git rev-list --count "$base_sha..$head_sha")
final_sha=$(
  git rev-list --reverse --topo-order "$base_sha..$head_sha" | tail -n 1
)
test "$commit_count" -gt 0 || {
  printf 'pinned PR range is empty\n' >&2
  exit 1
}
test "$final_sha" = "$head_sha" || {
  printf 'commit walk did not end at pinned head: %s\n' "$head_sha" >&2
  exit 1
}
printf '{"count":%s,"final_sha":"%s","current_base_sha":"%s"}\n' \
  "$commit_count" "$final_sha" "$fetched_base"
git rev-list --reverse --topo-order "$base_sha..$head_sha"
```

The leading `+` on both fetch refspecs is intentional: a previously fetched PR
or force-updated base must not make the receipt fail as a non-fast-forward
update. `baseRefOid` can legitimately predate the current base branch tip, so
require that exact commit object to exist rather than equating it with
`fetched_base`. Requiring the fetched PR ref to equal `headRefOid` detects a
head race; restart the capture if it changed. Git's `base..head` walk is the
complete source of truth because the GitHub PR commits endpoint returns at most
250 commits, while `gh pr view --json commits` exposes only the first 100.
Record the oldest-first `--topo-order` list and its count. Also record:

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

For multiple commits, preserve the pinned Git graph's oldest-first topological
order. Check `git rev-list --merges "$base_sha..$head_sha"` before cherry-pick;
if it is non-empty, plan an ancestry-aware import or reimplementation rather
than flattening merge commits blindly. Use `git range-diff` when the candidate
head changes or when validating a rebased port.

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
