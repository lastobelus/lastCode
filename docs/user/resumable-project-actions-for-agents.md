# Run Long Commands With an Agent

Ask your agent to run the workflow in its checkout. For a long build or test
run, LastCode can wake the thread when the command finishes so the agent can
act on the result. LastCode's own build and validation commands use
[`lc-run`](../lastcode/release.md#worktree-preparation) to register the wait
automatically.

For a workflow your team runs often, give agents the command, the condition
that ends the wait, and what they should do on success or failure. For a pull
request, ask the agent to [watch the PR](./source-control.md#linked-pull-requests).

You can still run saved Project Actions from the project. If your environment
uses legacy agent launches, see [the fallback guide](../internals/resumable-project-actions-for-agents.md).
