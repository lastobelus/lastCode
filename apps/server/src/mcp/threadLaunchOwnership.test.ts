import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveBatchLaunchOwnership, resolveLaunchOwnership } from "./threadLaunchOwnership.ts";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("launcher");
const groupId = ThreadId.make("group");
const otherProject = ProjectId.make("other-project");
const creator = { environmentId, threadId };
const caller = {
  id: threadId,
  projectId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
};
const context = { caller, client: undefined, environmentId };
const sender = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("remote-launcher"),
  title: "Remote launcher",
};
const linkedContext = {
  caller: undefined,
  client: { linked: true, senderThread: sender },
  environmentId,
};

describe("resolveLaunchOwnership", () => {
  it.each([
    [{}, projectId, threadId, true],
    [{}, otherProject, null, true],
    [{ groupedUnderThreadId: null }, projectId, null, true],
    [{ groupedUnderThreadId: groupId }, projectId, groupId, true],
    [{ topLevel: true }, projectId, null, false],
  ] as const)(
    "keeps ownership distinct from placement for %j",
    (request, project, placement, owned) => {
      const result = resolveLaunchOwnership(request, context);
      expect(result.forProject?.(project)).toEqual({
        creatorThreadId: threadId,
        creatorOrigin: { kind: "thread_launch", ...creator, owned },
        groupedUnderThreadId: placement,
      });
    },
  );

  it("records the linked sender without attributing execution delegation to an interactive launch", () => {
    const result = resolveLaunchOwnership({}, linkedContext);
    expect(result.forProject?.(projectId)).toEqual({
      creatorOrigin: {
        kind: "thread_launch",
        environmentId: sender.environmentId,
        threadId: sender.threadId,
        owned: true,
      },
      groupedUnderThreadId: null,
    });

    const delegated = resolveLaunchOwnership({ delegatedFrom: sender }, linkedContext);
    expect(delegated.forProject?.(projectId)).toEqual({
      delegatedFrom: sender,
      groupedUnderThreadId: null,
    });
    const outside = resolveLaunchOwnership(
      { delegatedFrom: sender },
      { ...linkedContext, client: { linked: false, senderThread: sender } },
    );
    expect(outside.forProject?.(projectId)).toEqual({ groupedUnderThreadId: null });
  });

  it("rejects conflicting delegation and placement before resolving the target project", () => {
    expect(
      resolveLaunchOwnership(
        { topLevel: true, delegatedFrom: { ...sender, threadId: groupId } },
        linkedContext,
      ).failure?.message,
    ).toBe("delegatedFrom must match the linked environment's launching thread.");
    expect(
      resolveLaunchOwnership({ topLevel: true, remotePreparation: {} }, linkedContext).failure
        ?.code,
    ).toBe("invalid_request");
    expect(
      resolveLaunchOwnership({ topLevel: true, groupedUnderThreadId: groupId }, context).failure
        ?.code,
    ).toBe("invalid_request");
  });
});

describe("resolveBatchLaunchOwnership", () => {
  it("keeps rows in request order and defaults to ungrouped from a side chat", () => {
    const requests = [{ title: "Owned" }, { title: "Independent", topLevel: true }];
    const result = resolveBatchLaunchOwnership(requests, creator, {
      ...caller,
      lineage: { ...caller.lineage, sideChat: true },
    });
    expect(result.rows).toEqual(
      requests.map((request, index) => ({
        request,
        ownership: {
          creatorThreadId: threadId,
          creatorOrigin: { kind: "thread_launch", ...creator, owned: index === 0 },
          groupedUnderThreadId: null,
        },
      })),
    );
  });

  it("rejects the whole batch if any explicit root has a placement parent", () => {
    expect(
      resolveBatchLaunchOwnership(
        [{ title: "Owned" }, { title: "Conflict", topLevel: true, groupedUnderThreadId: groupId }],
        creator,
        caller,
      ).failure?.code,
    ).toBe("invalid_request");
  });
});
