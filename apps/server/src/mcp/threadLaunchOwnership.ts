import {
  type EnvironmentId,
  type OrchestrationV2DelegatedFrom,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpCreateThreadRequest,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadCreatorOrigin,
  type ThreadId,
} from "@t3tools/contracts";
import type { ThreadOwner } from "@t3tools/shared/threadOwnership";

import type { McpClientCaller } from "./McpInvocationContext.ts";

type PlacementRequest = Pick<
  OrchestratorMcpCreateThreadRequest,
  "topLevel" | "groupedUnderThreadId"
>;
type LaunchRequest = PlacementRequest & {
  readonly delegatedFrom?: OrchestrationV2DelegatedFrom | undefined;
  readonly remotePreparation?: unknown;
};
type LaunchCaller = Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "lineage">;

export function resolveAgentCreator({
  caller,
  client,
  environmentId,
}: {
  readonly caller: Pick<LaunchCaller, "id"> | undefined;
  readonly client: Pick<McpClientCaller, "linked" | "senderThread"> | undefined;
  readonly environmentId: EnvironmentId;
}): ThreadOwner | undefined {
  if (caller !== undefined) return { environmentId, threadId: caller.id };
  const sender = client?.linked === true ? client.senderThread : undefined;
  if (sender !== undefined)
    return { environmentId: sender.environmentId, threadId: sender.threadId };
}

function launchCreatorOrigin(
  creator: ThreadOwner,
  topLevel: boolean | undefined,
): Extract<ThreadCreatorOrigin, { kind: "thread_launch" }> {
  return {
    kind: "thread_launch",
    environmentId: creator.environmentId,
    threadId: creator.threadId,
    owned: topLevel !== true,
  };
}

function topLevelPlacementFailure() {
  return new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "topLevel:true requires an independent launch with no placement parent.",
  });
}

function placementParent(request: PlacementRequest, defaultParent: ThreadId | null) {
  if (request.topLevel === true) return null;
  return request.groupedUnderThreadId === undefined ? defaultParent : request.groupedUnderThreadId;
}

export function resolveLaunchOwnership(
  request: LaunchRequest,
  {
    caller,
    client,
    environmentId,
  }: {
    readonly caller: LaunchCaller | undefined;
    readonly client: Pick<McpClientCaller, "linked" | "senderThread"> | undefined;
    readonly environmentId: EnvironmentId;
  },
) {
  const delegatedFrom = client?.linked === true ? request.delegatedFrom : undefined;
  const linkedCreator = client?.linked === true ? client.senderThread : undefined;
  if (
    delegatedFrom !== undefined &&
    linkedCreator !== undefined &&
    (delegatedFrom.environmentId !== linkedCreator.environmentId ||
      delegatedFrom.threadId !== linkedCreator.threadId)
  )
    return {
      failure: new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "delegatedFrom must match the linked environment's launching thread.",
      }),
    } as const;
  if (
    request.topLevel === true &&
    (request.groupedUnderThreadId != null ||
      request.remotePreparation !== undefined ||
      delegatedFrom !== undefined)
  )
    return { failure: topLevelPlacementFailure() } as const;

  const creator = resolveAgentCreator({ caller, client, environmentId });
  const creatorOrigin =
    creator === undefined || delegatedFrom !== undefined || request.remotePreparation !== undefined
      ? undefined
      : launchCreatorOrigin(creator, request.topLevel);

  return {
    // Placement needs the resolved project. Ownership validation runs before workspace lookup.
    forProject: (projectId: ProjectId) => ({
      ...(delegatedFrom === undefined ? {} : { delegatedFrom }),
      ...(caller === undefined ? {} : { creatorThreadId: caller.id }),
      ...(creatorOrigin === undefined ? {} : { creatorOrigin }),
      groupedUnderThreadId: placementParent(
        request,
        caller?.projectId === projectId && caller.lineage.sideChat !== true ? caller.id : null,
      ),
    }),
  } as const;
}

export function resolveBatchLaunchOwnership(
  requests: ReadonlyArray<OrchestratorMcpCreateThreadRequest>,
  creator: ThreadOwner,
  caller: LaunchCaller,
) {
  if (requests.some((request) => request.topLevel === true && request.groupedUnderThreadId != null))
    return { failure: topLevelPlacementFailure() } as const;

  const defaultParent = caller.lineage.sideChat === true ? null : caller.id;
  return {
    rows: requests.map((request) => ({
      request,
      ownership: {
        creatorThreadId: creator.threadId,
        creatorOrigin: launchCreatorOrigin(creator, request.topLevel),
        groupedUnderThreadId: placementParent(request, defaultParent),
      },
    })),
  } as const;
}
