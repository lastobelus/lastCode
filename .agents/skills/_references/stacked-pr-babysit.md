# Sequential Stack Babysitting

Use this reference for an identified LastCode stack or for a single PR checked
from a coordinator checkout. One thread owns the requested finish line and its
PR watches, and drives one member at a time. GitHub may run other members' CI
and reviews in parallel.

## Establish the stack

Resolve the live dependency chain from PR base branches. Record the repository,
canonical base, ordered PR numbers, parent branches and full head SHAs, requested
finish line, existing ownership/QA boundaries, and next member in a private work
artifact outside the repository. Refresh this record after each merge or
restack; it is continuation context, not validation evidence.

An explicit request to merge the whole identified stack authorizes its ordered
merges and necessary fixes, restacking, validation, and pushes. State the members
and proceed without asking again for every PR. Do not extend a single-PR merge
request to unapproved ancestors, absorb another owner's work, or override a QA
hold. Ask only when membership or authority is materially ambiguous.

The supported stack is a same-repository chain of open PRs ending at
`lastcode/main`. Missing or ambiguous parents, cycles, and an upstream `main`
base need agent attention. If an ancestor has already merged, reconcile and
retarget the child before selecting it. A parent branch name alone is not
evidence of its relationship to the intended PR.

## Check and watch stack members

Check any member from the coordinator's checkout:

```sh
pnpm lastcode:pr-gates --pr PR_NUMBER
```

Each run takes one confirmed GitHub snapshot, rebuilds the same-repository parent chain live down
to `lastcode/main`, and reports it with the decision; nothing is saved between
runs. It does not poll, request review, merge, or launch an Action. Compare the
reported head, base, and parent chain with the intended snapshot. A mismatch is
a reason to re-evaluate the changed revision, not to accept new evidence
silently. Without `--pr`, the check derives the PR from the checked-out branch
and requires a clean matching `HEAD`. A `--pr` check reads remote state only;
Quick CI and the merge guard still operate on the command's checkout.

Watch the member being driven with `watch_pull_request` and its explicit URL.
The watch does not notice base or parent drift on its own, so also watch an
unmerged parent whose pushes or retargets would invalidate the member's
evidence. Unwatch a member once it merges or is no longer being driven.

Before taking on fixes or restacking, establish that the thread's Action
checkout can safely become the intended clean validation checkout. Preserve
unrelated dirty work. If it cannot, report the specific checkout blocker or
hand the fixing step to its already-authorized owner; a second shell worktree
does not redirect Quick CI. Remote waiting alone does not require this change.

## Drive one member at a time

1. Start with the oldest unmerged authorized member. Handle current findings,
   release a draft only when its existing approval boundary permits, and request
   exact-head Codex review. Run its gate check; on `pending`, watch it (and any
   relevant parent) and end the turn.
2. On each wake, take a fresh snapshot and rerun the check for the member.
   Handle findings or drift before ending the turn again. Passing against a topic base is
   stack validation; final merge still requires current `lastcode/main`.
3. In merge mode, put the intended head in a clean owned checkout, run the
   required validation and existing guarded merge, and verify the result.
   Preserve other owners' checked-out branches and previews. If the original
   branch is in use elsewhere, an owned `lastcode/` coordinator branch at the
   intended head can provide the local validation checkout; push only the
   explicitly intended remote ref with a lease. That alias is not a merge
   checkout: the merge guard resolves the PR from its actual branch name. Use
   an owned clean checkout of that branch for the merge (an isolated clone if
   the shared worktree is in use). Never force a shared checkout.
4. After a parent squash-merges, use its captured pre-merge head as the boundary
   for transplanting the child's own commits onto current main. For a simple
   linear child, this is `git rebase --onto origin/lastcode/main OLD_PARENT_HEAD`
   in its owned checkout. Inspect the range/diff first; do not apply this recipe
   blindly to merge commits or a child that did not incorporate that parent head.
   Merely retargeting the PR can leave the parent's original commits in its range.
5. Verify the child retains its intended changes, retarget it to main, apply the
   current Quick CI policy before pushing, push with a lease, and request new
   review/CI. Local checks remain optional; exact GitHub CI remains required.
   Propagate changed ancestor boundaries through the remaining descendants.
   Repeat until every authorized member is verified merged.

If a pending Action continuation, such as Quick CI, blocks the next launch,
retain the next member and end the turn so delivery can occur. A successful
process does not imply its continuation was delivered. For an interrupted continuation requiring
Resume, report that specific blocker. Do not use manual polling as a fallback.

In babysit-only mode, visit each requested member sequentially, then refresh all
members before reporting completion. Any changed head or base invalidates that
member's earlier result. Report each child's parent and checked revision without
calling it ready to merge into main.

## Validation boundaries

Require a successful exact PR/head/base GitHub workflow and aggregate `CI Gate`,
terminal-handled Codex review, no unresolved review threads, and clean
mergeability against the selected base. Missing CI registration, a disabled
workflow, or CI for an old base is not successful stack validation.

Parent pushes and retargets can invalidate CI without changing the child's head.
Wait for fresh evidence. The watch never wakes for a run that never registers;
if a later check still reports missing registration, handle that blocker. Rerunning an old workflow alone does not prove the current base. Quick
CI continues to validate against the canonical workstream base; do not describe
its receipt as parent-relative validation.

The gate check never restacks, pushes, or merges. The existing main-only merge
guard and short shared main-write lock remain authoritative. After a verified
merge, record the merged member and perform the usual tracked-work bookkeeping.
At a blocker, report the completed members, remaining members, exact next step,
and any approval still required.
