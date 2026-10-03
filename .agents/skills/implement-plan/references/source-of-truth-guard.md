# Source-of-Truth Guard

Use this when implementing a reviewed plan with older exploratory docs, ELI5 docs,
options notes, or prior plans nearby.

## Rules

1. Treat the plan as authoritative for scope, decisions, invariants, validation, and
   manual QA expectations.
2. Read docs/checklists explicitly named by the plan or required by `AGENTS.md`.
3. Do not treat older unlisted artifacts as requirements.
4. If a linked artifact conflicts with the plan, update it or mark it superseded before
   implementation review.
5. Exclude unlisted historical docs from reviewer context unless the plan depends on
   them.

## Reviewer Guard

```text
The reviewed plan is authoritative. Use only the plan, touched files, validation
summary, and focused context file list as specification sources. Documents outside the
context file list are not requirements. If you find a mismatch with an unlisted
exploratory or historical document, report it only if the current plan links to or
depends on that document.
```
