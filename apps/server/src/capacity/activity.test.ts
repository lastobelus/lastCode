import { expect, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { capacityActivity } from "./activity.ts";

it("counts execution across projects and separates pause-held turns from starts", () => {
  const shell = (id: string, patch: Partial<OrchestrationV2ThreadShell>) => ({
    ...liveThreadShell(ThreadId.make(id)),
    ...patch,
  });
  const run = RunId.make("held-run");
  const held = shell("held", { status: "queued", activeRunId: run });
  const threads = [
    held,
    shell("starting", { status: "starting" }),
    shell("running", { status: "running" }),
    shell("waiting", { status: "waiting" }),
    shell("idle", { status: "completed", activeRunId: null }),
    shell("deleted", { status: "running", deletedAt: held.createdAt }),
  ];
  expect(capacityActivity(threads, [{ threadId: held.id, runId: run }], true)).toEqual({
    runningTurns: 2,
    startingTurns: 1,
    heldTurns: 1,
  });
  expect(capacityActivity(threads, [{ threadId: held.id, runId: run }], false)).toEqual({
    runningTurns: 2,
    startingTurns: 2,
    heldTurns: 0,
  });
  expect(
    capacityActivity(threads, [{ threadId: held.id, runId: RunId.make("old-run") }], true),
  ).toEqual({
    runningTurns: 2,
    startingTurns: 2,
    heldTurns: 0,
  });
});
