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
    "Report pause delivery and unfinished work. No need to call it before Pause or Resume. Excludes your current turn and managed previews without cleanup; includes commands, Actions, and cleanup. The environment is quiet only when quiet=true and observation=known.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPauseStartTool = Tool.make("t3_environment_pause_start", {
  ...pause,
  description:
    "Pause this whole environment when explicitly told to pause or go offline. Requires pause enabled and a live full-access/default thread or full-access client. Holds automatic thread wake-ups, then sends 'pause to go offline' to each active thread as an ordinary user message, steering running turns where the provider supports it. Returns immediately. After starting, stop work and end your turn.",
}).annotate(Tool.Destructive, true);
const EnvironmentPauseRetryTool = Tool.make("t3_environment_pause_retry", {
  ...pause,
  description:
    "Optional retry for failed deliveries. While pausing, resends failed pause messages and pauses threads that became active since; while resuming, resends failed resume messages. Delivered messages are not resent.",
}).annotate(Tool.Destructive, true);
const EnvironmentPauseResumeTool = Tool.make("t3_environment_pause_resume", {
  ...pause,
  description:
    "Resume this environment when explicitly told to. Works at any time, including while a pause is unfinished. Immediately lifts the hold on automatic thread wake-ups, cancels pause messages not yet delivered, and sends 'resume' only to threads that received Pause. Retry failed resumes with t3_environment_pause_retry. Archived or deleted threads need no message.",
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
