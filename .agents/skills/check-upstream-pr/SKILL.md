---
name: check-upstream-pr
description: Use when the user tells you to look at or check an upstream PR.
---

Confirm the upstream PR exists. If no PR is given or identifiable from context, ask for it; if it does not exist, ask for a corrected reference.

Rebase the PR, examining upstream changes carefully to determine:

- Is this PR still needed?
- Can/should it be refactored to use new upstream code?
- Does it remain valid with the current v2 orchestrator?
