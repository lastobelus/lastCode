# Context Hygiene Before Plan Review

Use this when a plan follows exploratory discussion, options docs, older plans, ELI5
HTML docs, or other idea artifacts.

## Goal

Make the on-disk planning packet coherent enough that reviewers can evaluate the plan
without treating stale artifacts as current requirements.

## Required Pass

1. Identify related artifacts a reviewer might find or that the thread relied on.
2. Classify each artifact:
   - `canonical-current`
   - `supporting-current`
   - `historical/superseded`
   - `unknown/conflicting`
3. Reconcile current artifacts:
   - update small stale artifacts when cheap and useful
   - mark stale artifacts as superseded when they should remain for history
   - remove stale links from the current plan
   - stop for user clarification only when conflicting artifacts change product scope
     and no safe assumption exists
4. Add a compact source-of-truth section to the plan when prior artifacts matter.
5. Build the reviewer context list from current sources only.

## Reviewer Prompt Guard

```text
The plan file is the current source of truth. Use only the plan and the focused context
file list as specification sources. Historical, exploratory, superseded, or unlisted
documents are not authoritative. Report a mismatch with those documents only when the
current plan links to them, depends on them, or should explicitly update/supersede them.
```
