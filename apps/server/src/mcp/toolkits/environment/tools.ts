import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  EnvironmentPauseStatus,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as EnvironmentPause from "../../../environment/EnvironmentPause.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and selected environment preferences. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const pause = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  success: EnvironmentPauseStatus,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    EnvironmentPause.EnvironmentPause,
  ],
};
const EnvironmentPauseStatusTool = Tool.make("t3_environment_pause_status", {
  ...pause,
  description:
    "Read this environment's durable pause session, delivery results, and current execution blockers. Only quiet=true with observation=known confirms the environment is quiet.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPauseStartTool = Tool.make("t3_environment_pause_start", {
  ...pause,
  description:
    "Start an environment-wide pause when explicitly instructed to pause or go offline. Requires environment pause enabled and a live full-access/default calling thread or full-access client. Saves the automatic wake gate and sends 'pause to go offline' to active threads cooperatively. Returns before those threads necessarily become quiet. After starting, stop work and end the turn; the app tracks quiet progress.",
}).annotate(Tool.Destructive, true);
const EnvironmentPauseRetryTool = Tool.make("t3_environment_pause_retry", {
  ...pause,
  description:
    "Recover the current environment pause session: retry failed deliveries and pause newly active threads while pausing, or retry remaining Resume deliveries while resuming. Successful deliveries are preserved. Requires a live full-access/default calling thread or full-access client.",
}).annotate(Tool.Destructive, true);
const EnvironmentPauseResumeTool = Tool.make("t3_environment_pause_resume", {
  ...pause,
  description:
    "Resume this environment when explicitly instructed. Releases the durable automatic wake gate and sends 'resume' to the threads that received Pause. Requires a live full-access/default calling thread or full-access client. Pending pause deliveries must settle first. Failures stay available for retry; archived or deleted recipients can finish recovery without a message.",
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentPauseStatusTool,
  EnvironmentPauseStartTool,
  EnvironmentPauseRetryTool,
  EnvironmentPauseResumeTool,
);
