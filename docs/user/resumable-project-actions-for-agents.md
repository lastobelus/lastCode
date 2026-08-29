# Use an Agent to Add Resumable Project Actions

An agent can turn a repetitive wait into a resumable Project Action and arrange for future threads
to use it without repeated reminders. This works especially well for pull-request checks, reviews,
long validation runs, builds, deployments, and other workflows that spend time waiting for an
external result.

For example, ask:

```text
Set up our pull-request babysitting workflow to use a resumable Project Action. Do the project work
and, with authorized computer use, configure and verify the Action in LastCode. Make future threads
use it automatically instead of polling or waiting in the agent turn.
```

The agent should inspect the existing workflow before changing it, preserve its acceptance gates,
and leave decisions such as fixing findings or merging for the resumed thread. It should report any
remaining one-time setup instead of claiming the Action is ready when it has not been verified.

If you want to point an agent at detailed instructions, give it this page. Before making changes,
the agent should continue with the
[agent implementation guide](../internals/resumable-project-actions-for-agents.md), which links to
the **Wait for PR** tutorial and setup runbook.

Once configured, ask for the ordinary workflow. A successful setup means the agent discovers and
launches the Action itself, ends its turn while the command runs, and continues from the automatic
follow-up when there is a result that needs attention.
