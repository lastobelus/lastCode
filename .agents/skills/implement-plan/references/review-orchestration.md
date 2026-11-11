# Implementation Review Orchestration

Run implementation review rounds with the global `review-loop` skill. Use real
reviews only. Do not simulate reviewer output.

## Review Depth

Map this skill's depth words onto `review-loop`'s round budget:

- `light implement-plan`: one round, as `review-loop`'s "just once".
- `heavy implement-plan`: up to three rounds.
- explicit `N rounds`: at most N rounds.
- default: `review-loop`'s default budget.

Give `review-loop` the plan file as the change's intent, including its must-keep
rules, and the validation already run.
