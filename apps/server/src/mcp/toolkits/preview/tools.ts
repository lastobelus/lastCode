import {
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationClickInput,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationMcpOpenInput,
  PreviewAutomationProfiles,
  PreviewAutomationPublishedDocumentError,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
  PreviewAutomationUnavailableError,
  PreviewHostingError,
  PreviewHostingLaunchInput,
  PreviewHostingLeaseSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PublishedDocumentPreview from "../../../preview/PublishedDocumentPreview.ts";
import * as PreviewHosting from "../../../preview/Hosting.ts";
import { PreviewRemoteUnavailableFailure } from "./errors.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

/** What a browser action fails with, including the access gate's refusal. */
const PreviewToolFailure = Schema.Union([
  PreviewAutomationError,
  PreviewRemoteUnavailableFailure,
  OrchestratorMcpFailure,
]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields);

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report preview tab state: owner, pending dialog, URL, title, loading, viewport, size, and actual profileId/profileName when supported. `tabs` lists this thread's tabs. `profiles` lists logins for `preview_open`. Read any listed tab. Act only on your tab, or an unclaimed tab with no human in control.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewProfilesTool = Tool.make("preview_profiles", {
  description:
    "List existing browser profiles (id, name, kind) and the configured defaultProfileId on this agent session's desktop host. Names may repeat; select a stable ID when they do. Named profiles share their sign-in across environments on that desktop; Default and Incognito remain environment-local. This tool does not create profiles, change the default, or open a tab.",
  success: PreviewAutomationProfiles,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List browser profiles")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewHostTool = Tool.make("preview_host", {
  description:
    "Prepare a retained thread-owned local web preview in a managed terminal. Provide the exact shell command, working directory, and local HTTP URL. The command can serve a development app or static HTML files. Use this before sharing the returned link. Processes sleep after 24 hours, but the saved setup and source remain until explicit stop or thread deletion. Opening the in-thread link restores a stopped server automatically for another run window. For isolated T3 dev QA, set browserAuth: t3-dev and retain a fixed T3CODE_DEV_AUTH_TOKEN in env; emit only the clean URL.",
  parameters: PreviewHostingLaunchInput,
  success: PreviewHostingLeaseSummary,
  failure: Schema.Union([
    PreviewHostingError,
    PreviewAutomationUnavailableError,
    OrchestratorMcpFailure,
  ]),
  dependencies: [...dependencies, PreviewHosting.PreviewHosting],
})
  .annotate(Tool.Title, "Host a local preview")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

const PreviewStopThreadTool = Tool.make("preview_stop_thread", {
  description:
    "Permanently cancel every managed preview lease and stop all app-managed terminal processes in this agent's own thread. Stopped previews cannot restart when their old links are opened. Ordinary terminal history is preserved, and other threads and agent providers are untouched.",
  success: PreviewActionResult,
  failure: Schema.Union([
    PreviewHostingError,
    PreviewAutomationUnavailableError,
    OrchestratorMcpFailure,
  ]),
  dependencies: [...dependencies, PreviewHosting.PreviewHosting],
})
  .annotate(Tool.Title, "Stop thread previews and processes")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Initialize a collaborative browser tab and open its thread-bound inline preview by default. Use target:{kind:'published-document',path:'report.html'} to open an exact file already published by an assistant in this calling thread, through signed HTTP in the environment browser. This target cannot be combined with url or desktop hosting; attachments are not supported. Set open=false for background-only automation. Choose browserHost='environment' for QA of this environment's loopback apps: the page runs on the server and streams into the same Browser panel, defaulting to isolated Incognito storage; explicitly selecting Default uses persistent storage in that environment. Choose browserHost='desktop' for desktop sign-ins such as Logged in Developer. Omit browserHost to retain the existing hosting policy. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab. To select an existing cookie jar without changing the default, use exactly one of profileName (exact unique name) or profileId from preview_profiles for desktop hosting, or Default/Incognito for environment hosting. Existing tabs retain their host and profile; a mismatch creates a new tab unless an exact tabId was supplied, which fails. Unknown or ambiguous profiles fail. Another agent session's tabs can be read but not operated. Parallel subagents must each open with reuseExistingTab=false and pass the returned tabId on every call.",
    parameters: PreviewAutomationMcpOpenInput,
    success: PreviewAutomationStatus,
    failure: Schema.Union([PreviewToolFailure, PreviewAutomationPublishedDocumentError]),
    dependencies: [...dependencies, PublishedDocumentPreview.PublishedDocumentPreview],
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss the dialog `preview_status` reports. Pass `promptText` to accept a prompt. Needs your own tab, or an unclaimed one. Desktop hosts may not support this.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate the chosen tab. Pass `url` for a website, or `target:{kind:'environment-port',port}` for a dev server. Exactly one of `url` and `target`.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize the chosen tab: {mode:'fill'}, {mode:'freeform',width,height}, or {mode:'preset',preset,orientation}. Changes CSS size only, not the user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Set `prefers-color-scheme` for the chosen tab: 'dark', 'light', or 'system' to clear the override.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Use it only when the current request asks for browser work, including checking an edit in the browser. Never use it unasked to verify your own edit, or to repeat a snapshot from an earlier turn. Works on a tab the user is driving. Returns page state, elements, diagnostics, and screenshot size when captured. Server tabs capture a screenshot only with `includeImage=true` or `save=true`. Target one element with `locator='aria-ref=<ref>'` from `accessibilityTree`, even in frames. Refs die on navigation, a new snapshot, or handoff. Text caps near 20 KB; on your own or an unclaimed tab, `preview_evaluate` reads more. To show a screenshot: `save=true`, then embed ![alt](screenshotPath).",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description: "Default false. True only to see the page.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description: "Write PNG, return `screenshotPath`.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description: "Click exactly one target. Prefer a Playwright locator. `x` and `y` go together.",
    parameters: PreviewAutomationClickInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description: "Type literal text into one input. `clear=true` replaces the current text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

const PreviewHoverTool = safeBrowserTool(
  Tool.make("preview_hover", {
    description: "Hover one target to show menus or tooltips.",
    parameters: PreviewAutomationHoverInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Hover preview page"),
);

const PreviewSelectTool = browserTool(
  Tool.make("preview_select", {
    description:
      "Pick options in one native <select>, by value or label. For a custom dropdown, click it open, then click the option.",
    parameters: PreviewAutomationSelectInput,
    success: Schema.Struct({
      ...PreviewAutomationSelectResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Select preview option"),
);

const PreviewDragTool = browserTool(
  Tool.make("preview_drag", {
    description: "Drag one element onto another.",
    parameters: PreviewAutomationDragInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Drag in preview page"),
);

const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Give files from this environment to the page. After a click opens a file picker, `preview_status` reports it. Pass absolute paths to answer it, or an empty list to cancel. Or pass a locator for an <input type=file>.",
    parameters: PreviewAutomationUploadInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Upload files to preview page"),
);

const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description: "Press one key, such as {key:'Enter'} or {key:'a',modifiers:['Meta']}.",
    parameters: PreviewAutomationPressInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the chosen tab, or one container with a locator or selector. Positive `deltaY` scrolls down. Positive `deltaX` scrolls right.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

/** Wrap non-objects: MCP requires object structuredContent, and Claude Code rejects invalid results entirely. */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
});

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Run JavaScript in the page. It can change page state. Returns `{value}`, up to 64 KB. Needs your tab, or an unclaimed one. To read a tab the user drives, use `preview_snapshot`. Page tools reached here: read data only, never create, save, or display. Show results with `html_render`.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait until all given locator, selector, text, and URL conditions match in the chosen tab.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording the chosen tab.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the chosen tab. Returns a local path to the recording file (max 50 MiB).",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewHostTool,
  PreviewStopThreadTool,
  PreviewStatusTool,
  PreviewProfilesTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewHostTool,
  PreviewStopThreadTool,
  PreviewStatusTool,
  PreviewProfilesTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
