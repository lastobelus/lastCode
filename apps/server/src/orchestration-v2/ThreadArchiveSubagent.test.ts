import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";

const parentThreadId = ThreadId.make("thread:subagent-snoozed-parent");
const childThreadId = ThreadId.make("thread:subagent-awake-child");
const parentProviderInstanceId = ProviderInstanceId.make("codex");
const childProviderInstanceId = ProviderInstanceId.make("claude");
const parentModelSelection = {
  instanceId: parentProviderInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const childModelSelection = {
  instanceId: childProviderInstanceId,
  model: "claude-opus-4-1",
} satisfies ModelSelection;
const parentCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const childCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeParentThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: parentThreadId,
    projectId: ProjectId.make("project:subagent-snooze"),
    title: "Snoozed parent",
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:subagent-snoozed-parent"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: parentThreadId,
    },
    forkedFrom: null,
    createdAt: parentCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
    historyOrigin: "v1_import",
  };
}

it.each(["stopping", "failed"] as const)(
  "native child construction keeps a compact %s archive reference through nested children",
  (status) => {
    const parentThread = {
      ...makeParentThread(),
      archivePending: {
        threadId: parentThreadId,
        commandId: CommandId.make("subagent-pending-archive"),
        status,
        ...(status === "failed" ? { error: "Fixture shutdown refused" } : {}),
        childDisposition: "stop_and_archive" as const,
        childThreadIds: Array.from({ length: 128 }, (_, index) =>
          ThreadId.make(`family-child:${index}`),
        ),
        archiveThreadIds: [parentThreadId],
        promoteThreadIds: [],
        modeLimit: { runtimeMode: "approval-required" as const, interactionMode: "plan" as const },
      },
    };
    const makeChild = (parent: OrchestrationV2AppThread, id: ThreadId) =>
      makeSubagentChildThread({
        parentThread: parent,
        childThreadId: id,
        parentNodeId: NodeId.make("node:subagent-parent"),
        activeProviderThreadId: null,
        providerInstanceId: childProviderInstanceId,
        modelSelection: childModelSelection,
        title: "Late native child",
        now: childCreatedAt,
        createdBy: "agent",
        creationSource: "provider",
      });
    const child = makeChild(parentThread, childThreadId);
    const nested = makeChild(child, ThreadId.make("nested-late-native-child"));
    const expected = {
      threadId: parentThreadId,
      commandId: parentThread.archivePending.commandId,
      status,
      ...(status === "failed" ? { error: "Fixture shutdown refused" } : {}),
    };
    assert.deepEqual(child.archivePending, expected);
    assert.deepEqual(nested.archivePending, expected);
    assert.lengthOf(parentThread.archivePending.childThreadIds, 128);
    assert.deepEqual(parentThread.archivePending.modeLimit, {
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
  },
);
