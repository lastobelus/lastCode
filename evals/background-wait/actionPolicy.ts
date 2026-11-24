import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  PROJECT_ACTION_LAUNCH_DISABLED,
  PROJECT_ACTION_ORCHESTRATION_INSTRUCTIONS,
  projectActionHandoffInstructions,
  projectActionOrchestrationSections,
} from "@t3tools/provider-core/server/lastcodeProjectActions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { McpSchema, Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import {
  McpInvocationContext,
  type McpCapability,
} from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { visibleWithProjectActionLaunch } from "../../apps/server/src/mcp/toolkits/actionResume/LastCodeActionToolAccess.ts";
import { ActionResumeToolkit } from "../../apps/server/src/mcp/toolkits/actionResume/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";

const actionTools: readonly Tool.Any[] = Object.values(ActionResumeToolkit.tools);
const enabledWhen = (tool: Tool.Any) =>
  Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);

const hiddenActionToolNames = actionTools
  .filter((tool) => enabledWhen(tool) === visibleWithProjectActionLaunch)
  .map((tool) => tool.name);
const recoveryToolNames = actionTools
  .filter((tool) => enabledWhen(tool) !== visibleWithProjectActionLaunch)
  .map((tool) => tool.name);

export const catalogMarker = "bw-action-catalog ";
export const codexCatalogProbe =
  "Before the task, record the current T3 tool catalog for the eval. In functions.exec run exactly " +
  "`text('" +
  catalogMarker +
  "' + JSON.stringify(ALL_TOOLS.map(t => t.name).filter(n => /^mcp__t3[-_]code__.*action/.test(n))))`. " +
  "Then continue with the task.";

export type ActionCatalogCheck = "verified" | "mismatch" | "unverified";

export function checkActionCatalog(
  names: readonly string[] | undefined,
  disabled: boolean,
): ActionCatalogCheck {
  if (names === undefined) return "unverified";
  const listed = new Set(names.map((name) => name.split("__").at(-1)));
  return recoveryToolNames.every((name) => listed.has(name)) &&
    hiddenActionToolNames.every((name) => listed.has(name) !== disabled)
    ? "verified"
    : "mismatch";
}

export function standingActionPolicy(disabled: boolean, provider: "codex" | "claudeAgent") {
  const capabilities = new Set<McpCapability>(["action-resume"]);
  if (disabled) capabilities.add(PROJECT_ACTION_LAUNCH_DISABLED);
  if (disabled || provider === "claudeAgent") capabilities.add("background-wait");

  const visible = Effect.sync(() => {
    const tools: readonly Tool.Any[] = [
      ...actionTools,
      OrchestratorToolkit.tools.t3_background_wait,
    ];
    return tools.filter(
      (tool) => enabledWhen(tool)?.({ protocolVersion: "", capabilities: {} }) ?? true,
    );
  }).pipe(
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:eval"),
      requestNamespace: "background-wait-eval",
      capabilities,
      thread: {
        threadId: ThreadId.make("thread:eval"),
        providerSessionId: "provider-session:eval",
        providerInstanceId: ProviderInstanceId.make(provider),
      },
      client: undefined,
      issuedAt: 0,
    }),
    Effect.runSync,
  );
  return {
    instructions:
      projectActionOrchestrationSections(
        [PROJECT_ACTION_ORCHESTRATION_INSTRUCTIONS],
        disabled,
      ).join("") + projectActionHandoffInstructions(disabled),
    toolDefinitions: JSON.stringify(
      visible.map((tool) => ({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: advertisedJsonSchema(tool),
      })),
    ),
  };
}
