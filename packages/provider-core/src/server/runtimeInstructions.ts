import type { AgentFeedbackMode } from "@t3tools/contracts";

import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";
import { projectActionHandoffInstructions } from "./lastcodeProjectActions.ts";

/** None while agent feedback is off, so users who never opt in pay no context for it. */
export const AGENT_FEEDBACK_INSTRUCTIONS = {
  off: "",
  "on-request": "Use `t3_feedback` only when the user asks you to send T3 feedback.",
  auto: "`t3_feedback` reports are wanted and cheap. Send one, then continue, when a T3 tool or `t3` command fails or gives a wrong result, the user corrects how you use T3 Code, or a T3 capability you looked for is missing. Once per problem; also when the user asks. Only about T3 Code, never the user's code or other tools.",
} satisfies Record<AgentFeedbackMode, string>;

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const pullRequestLinkingInstructions = (
  actionLaunchDisabled = false,
) => `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools don't link for you. If linking fails, say so. Skip PRs you only read or review and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch, run any required project gate check once, and end your turn while gates are pending. Otherwise act now or hand back. An app-owned delegated child owns a PR watch only when its brief says the parent verified features.appOwnedPullRequestWatchContinuationVersion and #482 Phase 4 acceptance of that destination's installed checkpoint, or authorized an isolated acceptance scenario; Action ownership, the flag in source, or a newer-looking version does not count. Otherwise, or if the watch is refused, the child ends with an unfinished handoff asking its parent to own the watch. An owning child ends each turn unfinished while waiting and continues only on its own watch wakes; its parent does not poll, read, or relay those events. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch. When pull_request_* tools are listed, use them, not gh or cafe, to read, list, open, edit, review, reply on, close, or merge PRs, and ci_logs and ci_rerun for their checks. pull_request_create links for you.
If available, call link_issue for each issue you take on or file, even via CLI; skip issues you only read.${projectActionHandoffInstructions(actionLaunchDisabled)}
</pull_request_linking>`;

export const PULL_REQUEST_LINKING_INSTRUCTIONS = pullRequestLinkingInstructions();

const PREVIEW_HANDOFF_INSTRUCTIONS = `<preview_handoffs>
When the t3-code MCP server exposes preview_host, launch temporary QA dev servers and HTML servers through that tool before handing the user a link. Supply the exact command, absolute working directory, local URL, required environment overrides, and source worktree path. Keep HTML and its supporting files in the workspace. The tool retains the handoff recipe and source until explicit stop, thread archive or deletion, or automatic workspace suspension. Its process sleeps after 24 hours; opening the in-thread link or retained Browser panel restores it without another agent turn and starts a fresh run window. Process expiry is not handoff expiry. Do not stop its terminal or delete its files at turn end or while waiting for acceptance. Prepare requested manual QA without asking the user to start a QA window: leave the scenario ready and emit a clean integrated-browser link. For T3 dev QA, retain a fixed T3CODE_DEV_AUTH_TOKEN in the launch environment and set browserAuth:"t3-dev" so opening the link renews authentication; never emit the credential. If a browser fault repeats after a corrected diagnostic attempt, coordinate one investigation with a clear owner; do not repeatedly ask another blocked thread to perform the same QA or ask the user to reconnect an unspecified host. Ordinary QA explicitly selects Default or a dedicated QA profile. GitHub uploads and other authenticated GitHub work explicitly select Logged in Developer in a separate tab after preview_profiles; never change the default profile to obtain a login. Do not substitute a provider background shell, nohup, tmux, a longer timeout, or an external daemon. A link produced without preview_host has no managed server lifetime guarantee. Persistent LastCode-hosted HTML assets can use the existing file-preview path without a temporary server.
</preview_handoffs>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructionSections(runtime: {
  readonly harness: string;
  readonly agentFeedback?: AgentFeedbackMode;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  readonly projectActionLaunchDisabled?: boolean | undefined;
}): readonly [string, string] {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>`;
  const feedbackLine = AGENT_FEEDBACK_INSTRUCTIONS[runtime.agentFeedback ?? "off"];
  const feedback = feedbackLine ? `\n${feedbackLine}` : "";
  const linkingInstructions =
    runtime.pullRequestLinking === false
      ? ""
      : `\n\n${pullRequestLinkingInstructions(runtime.projectActionLaunchDisabled)}`;
  return [`${runtimeInfo}${linkingInstructions}${feedback}`, PREVIEW_HANDOFF_INSTRUCTIONS];
}

export function buildRuntimeInstructions(
  runtime: Parameters<typeof buildRuntimeInstructionSections>[0] & {
    /** Adds the folder list of a multi-folder thread. */
    readonly runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace"> | undefined;
  },
): string {
  const sections = buildRuntimeInstructionSections(runtime);
  const workspace =
    runtime.runtimePolicy === undefined ? "" : buildWorkspaceInstructions(runtime.runtimePolicy);
  return workspace === "" ? sections.join("\n\n") : [...sections, workspace].join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

// Codex truncates context entries over 4,000 bytes, and this block is sent as its own entry.
const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 3_600;
const FOLDER_NAME_MAX_LENGTH = 64;
// Control characters and Unicode line separators would let a name or path add lines.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const textEncoder = new TextEncoder();

const byteLength = (value: string) => textEncoder.encode(value).length;

/** Names come from users and disk; keep each one a short label that cannot close the block. */
function folderLabel(name: string): string {
  const label = Array.from(
    name.replaceAll(LINE_BREAKING, " ").replaceAll(/[<>`]/g, " ").replaceAll(/\s+/g, " ").trim(),
  );
  if (label.length === 0) return "folder";
  return label.length > FOLDER_NAME_MAX_LENGTH
    ? `${label.slice(0, FOLDER_NAME_MAX_LENGTH - 1).join("")}…`
    : label.join("");
}

const folderPath = (value: string) =>
  value.replaceAll(LINE_BREAKING, "?").replaceAll("<", "‹").replaceAll(">", "›");

/** Lists a multi-folder thread's folders. Empty for single-folder threads, so their text is unchanged. */
export function buildWorkspaceInstructions(
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace">,
): string {
  const workspace = runtimePolicy.workspace;
  if (workspace === undefined || workspace.folders.length === 0) return "";
  const head = [
    "<workspace_folders>",
    "This project spans several folders. Each Git repository has its own history and branches: run Git commands inside the repository you change, and commit each one separately.",
    ...(runtimePolicy.cwd === null
      ? []
      : [`- Your working directory: ${folderPath(runtimePolicy.cwd)}`]),
  ];
  const tail = ["</workspace_folders>"];
  const entries = workspace.folders.map(
    (folder) =>
      `- ${folderLabel(folder.name)} (${folder.isGitRepository ? "Git repository" : "folder"}): ${folderPath(folder.path)}`,
  );
  // Reserve room for the line that counts folders left out.
  let budget = WORKSPACE_INSTRUCTIONS_MAX_BYTES - byteLength([...head, ...tail].join("\n")) - 32;
  const shown: Array<string> = [];
  for (const entry of entries) {
    budget -= byteLength(entry) + 1;
    if (budget < 0) break;
    shown.push(entry);
  }
  const hidden = entries.length - shown.length;
  return [...head, ...shown, ...(hidden > 0 ? [`- Not listed: ${hidden} more`] : []), ...tail].join(
    "\n",
  );
}
