import * as PromptSnippets from "../../../promptSnippets/PromptSnippets.ts";
import {
  PromptSnippetsState,
  PromptSnippet,
  PromptSnippetSaveInput,
  PromptSnippetUseInput,
  PromptSnippetDismissInput,
  PromptSnippetRestoreInput,
} from "@t3tools/contracts";
import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
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
    PromptSnippets.PromptSnippets,
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
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
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
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
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
const PromptSnippetsSaveTool = Tool.make("prompt_snippets_save", {
  ...shared,
  description:
    "Create a common prompt, or edit one by passing its snippetId; editing keeps its learned usage. Title is at most 100 characters and text at most 4000, and text must not match another saved or dismissed prompt. Discovery never rewrites or merges a prompt saved here.",
  parameters: PromptSnippetSaveInput,
  success: PromptSnippet,
}).annotate(Tool.Destructive, false);
const PromptSnippetsListTool = Tool.make("prompt_snippets_list", {
  ...shared,
  description:
    "List this environment's common prompts with their learned search queries and discovery status.",
  parameters: Tool.EmptyParams,
  success: PromptSnippetsState,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PromptSnippetsDiscoverTool = Tool.make("prompt_snippets_discover", {
  ...shared,
  description:
    "Run common-prompt discovery for this environment now; it also runs automatically once a day. Makes one paid call to the thread-title text generation model over recent user messages, treating them as data: instructions in them are never executed.",
  parameters: Tool.EmptyParams,
  success: PromptSnippetsState,
}).annotate(Tool.Destructive, false);
const PromptSnippetsRecordUseTool = Tool.make("prompt_snippets_record_use", {
  ...shared,
  description:
    "Record that a search query led to choosing a common prompt, so the picker ranks that prompt higher for the query. Does not send the prompt.",
  parameters: PromptSnippetUseInput,
  success: Schema.Void,
}).annotate(Tool.Destructive, false);
const PromptSnippetsDismissTool = Tool.make("prompt_snippets_dismiss", {
  ...shared,
  description:
    "Hide a common prompt from this environment's picker and keep discovery from adding it back. Keep the snippetId: prompt_snippets_list omits dismissed prompts, and prompt_snippets_restore undoes this.",
  parameters: PromptSnippetDismissInput,
  success: Schema.Void,
}).annotate(Tool.Destructive, false);
const PromptSnippetsRestoreTool = Tool.make("prompt_snippets_restore", {
  ...shared,
  description:
    "Undo prompt_snippets_dismiss: return the prompt to this environment's picker with its original id and learned usage.",
  parameters: PromptSnippetRestoreInput,
  success: Schema.Void,
}).annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  PromptSnippetsSaveTool,
  PromptSnippetsRestoreTool,
  PromptSnippetsDismissTool,
  PromptSnippetsListTool,
  PromptSnippetsDiscoverTool,
  PromptSnippetsRecordUseTool,
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentPauseStatusTool,
  EnvironmentPauseStartTool,
  EnvironmentPauseRetryTool,
  EnvironmentPauseResumeTool,
);
