import { EnvironmentId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { makeRawThreadShell } from "../test-fixtures";
import { threadDetailToShell } from "./thread-detail-to-shell";

it.each([undefined, null, ThreadId.make("organization:parent")])(
  "preserves detail placement %s when the normal shell is unavailable",
  (groupedUnderThreadId) => {
    const projection: OrchestrationV2ThreadProjection = {
      thread: {
        ...makeRawThreadShell(),
        lastVisitedAt: null,
        creatorThreadId: ThreadId.make("organization:creator"),
        creatorGrouping: "grouped",
        ...(groupedUnderThreadId === undefined ? {} : { groupedUnderThreadId }),
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: makeRawThreadShell().updatedAt,
    };
    const shell = threadDetailToShell(EnvironmentId.make("organization:environment"), projection);
    expect(shell.groupedUnderThreadId).toBe(groupedUnderThreadId);
    expect(Object.hasOwn(shell, "groupedUnderThreadId")).toBe(groupedUnderThreadId !== undefined);
    expect(Object.hasOwn(shell.source, "groupedUnderThreadId")).toBe(
      groupedUnderThreadId !== undefined,
    );
    expect(shell.creatorThreadId).toBe(projection.thread.creatorThreadId);
  },
);
