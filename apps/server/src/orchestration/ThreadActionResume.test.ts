import { assert, it } from "@effect/vitest";
import { type ActionResumeState, ProjectId, ThreadId } from "@t3tools/contracts";

import { make } from "./ThreadActionResume.ts";

const threadId = ThreadId.make("thread-action-resume-hydration");
const projectId = ProjectId.make("project-action-resume-hydration");

const state = (input: Partial<ActionResumeState>): ActionResumeState => ({
  runId: "completed-run",
  threadId,
  projectId,
  actionId: "qa",
  actionName: "QA",
  terminalId: "action-completed-run",
  outcome: "succeeded",
  delivery: "pending",
  startedAt: "2026-08-17T00:00:00.000Z",
  finishedAt: "2026-08-17T00:01:00.000Z",
  exitCode: 0,
  exitSignal: null,
  ...input,
});

it("does not resurrect stale pending state for a settled Action", () => {
  const registry = make();

  registry.hydrate([
    state({ outcome: "running", delivery: "armed", finishedAt: null, exitCode: null }),
    state({ delivery: "available" }),
    state({ delivery: "delivered" }),
    state({ delivery: "disposed" }),
    state({ delivery: "pending" }),
  ]);

  assert.deepInclude(registry.getLatest(threadId), {
    outcome: "succeeded",
    delivery: "disposed",
  });
  assert.isNull(registry.getForShell(threadId));
});

it("keeps a genuinely pending newer Action visible after hydration", () => {
  const registry = make();

  registry.hydrate([
    state({ delivery: "delivered" }),
    state({
      runId: "newer-run",
      terminalId: "action-newer-run",
      delivery: "pending",
      startedAt: "2026-08-17T00:02:00.000Z",
      finishedAt: "2026-08-17T00:03:00.000Z",
    }),
  ]);

  assert.deepInclude(registry.getForShell(threadId), {
    runId: "newer-run",
    delivery: "pending",
  });
});
