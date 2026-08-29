# Implementation Tutorial: Build a Resumable Wait Like Wait for PR

LastCode's **Wait for PR** Action illustrates a useful resumable workflow: the agent prepares a
pull request, hands passive GitHub waiting to a dedicated process, and returns only when there is a
decision to make.

This tutorial focuses on the pattern rather than requiring another project to copy LastCode's
GitHub policy.

## 1. Define what the agent is waiting for

Start with a sentence that has a terminal condition:

> Wait until hosted CI and review are complete for this exact pull-request revision, or return
> earlier when failure, drift, or a review finding requires the agent.

This is better than "wait for CI" because it identifies both the success condition and the events
that should wake the agent early.

For **Wait for PR**, the observed identity includes the pull-request number, head commit, base
commit, and tested merge commit. If one changes, the previous result no longer authorizes a merge.
Other workflows can use a deployment ID, artifact request token, job ID, or immutable tag.

## 2. Validate before entering the wait loop

Fail immediately when waiting cannot produce a trustworthy answer. A pull-request wait might
require:

- an authenticated GitHub CLI;
- a checked-out branch with an open pull request;
- a clean worktree at the expected head;
- the expected base branch; and
- evidence that review was actually requested.

Early validation turns configuration mistakes into quick Action results instead of threads that
appear to wait forever.

## 3. Separate observations from decisions

Read current state into one small observation, then use a pure decision function to classify it.
A simplified version looks like this:

```js
function decide(baseline, current) {
  if (current.pr !== baseline.pr || current.head !== baseline.head) {
    return { kind: "wake", reason: "target-changed" };
  }
  if (current.ci === "failed") return { kind: "wake", reason: "ci-failed" };
  if (current.reviewFindings > 0) {
    return { kind: "wake", reason: "review-findings" };
  }
  if (current.ci === "passed" && current.review === "complete") {
    return { kind: "wake", reason: "ready" };
  }
  return { kind: "wait", reason: "checks-pending" };
}
```

This split makes the important behavior testable without GitHub, timers, or terminal automation.
Test each wake reason and any transitions where stale success could otherwise be accepted.

## 4. Let the command wait, not the agent

The Action process can observe on a conservative interval. Print only when the meaningful state
changes, and put timeouts around remote calls so one network request cannot stall the process
forever.

```js
const baseline = await observe();
let previous = "";

for (;;) {
  const current = await observe();
  const decision = decide(baseline, current);

  if (decision.kind === "wake") {
    console.log(
      `[wait-for-pr] Summary: ${JSON.stringify({
        reason: decision.reason,
        pr: current.pr,
        head: current.head,
        ci: current.ci,
        review: current.review,
      })}`,
    );
    break;
  }

  const state = JSON.stringify(current);
  if (state !== previous) console.log(`[wait-for-pr] Waiting: ${state}`);
  previous = state;
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
```

Use exit codes consistently. A terminal workflow outcome such as "review findings need work" may
still be a successful observation with exit code 0, while a broken CLI invocation or unreadable
response should normally exit nonzero. The final summary must make the distinction clear.

## 5. Wake for decisions, not only success

**Wait for PR** returns when the agent can usefully act. Typical wake reasons include:

- CI and review are ready for the exact target;
- CI failed or its required configuration is missing;
- review findings or unresolved threads require attention;
- the head, base, merge commit, local worktree, or pull request changed;
- the pull request was closed, became a draft, or became unmergeable; and
- registration, mergeability, or review exceeded a meaningful timeout.

This creates a loop at the workflow level:

```text
agent prepares exact target
        ↓
Action waits for external state
        ↓
agent handles result or makes decision
        ↓
new exact target → Action waits again
```

The Action should not merge, rewrite the branch, dismiss findings, or choose a recovery policy.
Those operations remain visible in the agent turn.

## 6. Make the compact result useful

Long terminal output is available after expansion, but the compact card shows the final output
line. End with one machine-readable or consistently structured summary containing:

- why the Action stopped;
- the exact target identity;
- the final external state; and
- a URL or other useful artifact identifier.

For example:

```text
[wait-for-pr] Summary: {"reason":"ready","pr":42,"head":"abc123","ci":"passed","review":"complete"}
```

Avoid putting a progress line after the summary, including cleanup messages from shell traps.

## 7. Declare and configure the Action

Add an importable command to the repository's `t3.json`:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [
    {
      "name": "Wait for PR",
      "command": "node scripts/wait-for-pr.mjs",
      "icon": "test"
    }
  ]
}
```

Import it in **Settings → Projects**, edit it, and enable **Allow Codex and Claude to run and
resume**. Importing never enables this permission automatically. The setup can be completed by the
agent with authorized computer use; see the [setup guide](./resumable-project-actions-setup.md).

## 8. Teach the repository workflow to use it

Put an explicit handoff in the repository's agent instructions or delivery skill:

```markdown
After pushing the reviewed head, request the required hosted review, list Project Actions, launch
the eligible `Wait for PR` Action, and end the turn. On resume, verify that the reported PR and head
still match. Address findings and relaunch after each new head. Merge only after the Action reports
the exact target ready. Do not manually poll while the Action is available.
```

This instruction matters as much as the command. In LastCode's own rollout, agents reverted to
manual polling when older workflow text still prescribed it or mentioned **Wait for PR** without
the exact list-launch-end-turn sequence.

## 9. Walk through one cycle

With the script, saved Action, and agent instructions in place, a normal cycle is:

1. The agent finishes focused validation, creates or updates the pull request, and requests review.
2. The agent calls `list_project_actions` and finds `Wait for PR` eligible.
3. The agent calls `run_project_action_and_resume` with the returned ID and ends its turn.
4. The Action observes CI and review in its own terminal. The user can inspect or cancel it.
5. A review finding appears. The Action prints a final `review-findings` summary and exits.
6. LastCode returns the result to the same thread. The agent verifies and fixes the finding, pushes
   a new head, requests review again, and relaunches the Action.
7. The next result reports `ready` for the new exact head. The agent performs the guarded merge as
   a separate decision.

The user does not need to say "check again," remind the agent which command to run, or keep the
thread occupied while GitHub is idle.

## Adapt the pattern

The same shape works beyond pull requests:

- A deployment wait binds to one deployment ID and wakes on healthy, failed, superseded, or timed
  out.
- An artifact build binds to an immutable tag and unique dispatch token and wakes with the build
  URL and checksum result.
- A long validation Action binds to the starting commit and wakes if the worktree changes before
  its receipt can be trusted.
- A data import binds to a job ID and wakes on completed, rejected rows, failed, or cancelled.

In every case, move passive observation into the Action and keep policy decisions in the resumed
agent turn.
