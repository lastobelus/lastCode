import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  OrchestratorMcpDelegateTaskInput,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ActionResume } from "../../apps/server/src/actionResume/ActionResume.ts";
import type { McpThreadInvocationScope } from "../../apps/server/src/mcp/McpInvocationContext.ts";
import {
  idleThreadProjection,
  liveThreadShell,
} from "../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../apps/server/src/mcp/OrchestratorMcpService.ts";
import { ThreadReadBroker } from "../../apps/server/src/mcp/ThreadReadBroker.ts";
import { ProviderAdapterRegistryV2 } from "../../apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../../apps/server/src/orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { PeerForwarding } from "../../apps/server/src/peer/PeerForwarding.ts";
import { PeerLinks } from "../../apps/server/src/peer/PeerLinks.ts";
import { RemoteDelegation } from "../../apps/server/src/peer/RemoteDelegation.ts";
import { ProjectService } from "../../apps/server/src/project/ProjectService.ts";
import { ProviderRegistry } from "../../apps/server/src/provider/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../apps/server/src/scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../../apps/server/src/secrets/SecretRequests.ts";
import { ServerSettingsService } from "../../apps/server/src/serverSettings.ts";
import { GitVcsDriver } from "../../apps/server/src/vcs/GitVcsDriver.ts";

const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");
const shell = { ...liveThreadShell(threadId), projectId: ProjectId.make("acme-app") };
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
  requestNamespace: "mcp-tool-use-eval",
  thread: {
    threadId,
    providerSessionId: "mcp-tool-use-eval",
    providerInstanceId: shell.providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const run: OrchestrationV2Run = {
  id: RunId.make("run:local-project-refusal"),
  threadId,
  ordinal: 1,
  providerInstanceId: shell.providerInstanceId,
  modelSelection: shell.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:local-project-refusal"),
  rootNodeId: NodeId.make("node:local-project-refusal"),
  activeAttemptId: null,
  status: "running",
  requestedAt: shell.createdAt,
  startedAt: shell.createdAt,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};

const layer = OrchestratorMcpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ActionResume)({}),
      Layer.mock(ThreadReadBroker)({
        forSession: () => ({ authorize: () => Effect.die("The refusal does not read threads.") }),
      }),
      Layer.mock(PeerForwarding)({}),
      Layer.mock(PeerLinks)({}),
      Layer.mock(ThreadManagementService)({
        getThreadRecords: () => Effect.succeed({ ...idleThreadProjection(shell), runs: [run] }),
      }),
      Layer.mock(ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver)({}),
      Layer.mock(ProviderRegistry)({}),
      Layer.mock(ProviderAdapterRegistryV2)({}),
      Layer.mock(ScheduledTaskService)({}),
      Layer.mock(ProjectService)({}),
      Layer.mock(SecretRequests)({}),
      Layer.mock(ServerSettingsService)({}),
      Layer.mock(RemoteDelegation)({}),
    ),
  ),
);
const decodeRequest = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskInput);

/** Read the current server's refusal without starting any task or binding a workspace. */
export const localProjectRefusal = Effect.fn("evaluateMcpToolUse.localProjectRefusal")(function* (
  input: unknown,
) {
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  const request = yield* decodeRequest(input);
  const refusal = yield* Effect.flip(service.delegateTask(scope, request));
  if (refusal.code !== "invalid_request") return yield* refusal;
  return refusal;
}, Effect.provide(layer));
