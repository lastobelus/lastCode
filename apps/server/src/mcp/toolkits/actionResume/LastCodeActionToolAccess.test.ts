import { it } from "@effect/vitest";
import { ActionResumeError, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PROJECT_ACTION_LAUNCH_DISABLED } from "@t3tools/provider-core/server/lastcodeProjectActions";
import { McpSchema, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { ActionResume } from "../../../actionResume/ActionResume.ts";
import { layerActionResumeToolkit, layerInProcessMcpServer } from "../../McpHttpServer.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const clientInfo = { name: "lastcode-action-tools-test", version: "1.0.0" };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo,
  protocolVersion: "2025-06-18",
  initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
  getClient: Effect.die("No client callbacks expected."),
});

const threadId = ThreadId.make("thread:actions");
const launchTools = [
  "list_project_actions",
  "run_project_action_and_resume",
  "discard_interrupted_action",
];

it.effect.each([false, true])(
  "applies the session's Action launch policy (disabled %s)",
  (disabled) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const tools = server.tools.filter(({ annotations }) => {
        const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen);
        return enabledWhen?.({ protocolVersion: "2025-06-18", capabilities: {} }) ?? true;
      });
      expect(tools.map(({ tool }) => tool.name).sort()).toEqual(
        [
          "inspect_action_run",
          "resume_interrupted_action",
          ...(disabled ? [] : launchTools),
        ].sort(),
      );

      const call = server.callTool({
        name: "run_project_action_and_resume",
        arguments: { actionId: "ci" },
      });
      if (disabled) {
        const error = yield* Effect.flip(call);
        expect(error.message).toBe("Tool 'run_project_action_and_resume' not found");
      } else {
        const result = yield* call;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Action launch reached the service.");
      }

      const resumed = yield* server.callTool({
        name: "resume_interrupted_action",
        arguments: {},
      });
      expect(resumed.structuredContent).toEqual({ resumed: true });
    }).pipe(
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:test"),
        requestNamespace: "provider-session:actions",
        thread: {
          threadId,
          providerSessionId: "provider-session:actions",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>(
          disabled ? ["action-resume", PROJECT_ACTION_LAUNCH_DISABLED] : ["action-resume"],
        ),
        issuedAt: 1,
      }),
      Effect.provide(
        layerActionResumeToolkit.pipe(
          Layer.provideMerge(layerInProcessMcpServer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provideMerge(
            Layer.mock(ActionResume)({
              runProjectActionAndResume: () =>
                Effect.fail(
                  new ActionResumeError({
                    reason: "action_not_found",
                    message: "Action launch reached the service.",
                  }),
                ),
              resumeInterrupted: (id) => Effect.sync(() => expect(id).toBe(threadId)),
            }),
          ),
        ),
      ),
    ),
);
