const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

const PREVIEW_HANDOFF_INSTRUCTIONS = `<preview_handoffs>
When the t3-code MCP server exposes preview_host, launch temporary QA dev servers and HTML servers through that tool before handing the user a link. Supply the exact command, absolute working directory, local URL, required environment overrides, and source worktree path. Keep HTML and its supporting files in the workspace. The tool retains the handoff recipe and source until explicit stop or thread deletion. Its process sleeps after 24 hours; opening the in-thread link or retained Browser panel restores it without another agent turn and starts a fresh run window. Process expiry is not handoff expiry. Do not stop its terminal or delete its files at turn end or while waiting for acceptance. Prepare requested manual QA without asking the user to start a QA window: leave the scenario ready and emit a clean integrated-browser link. For T3 dev QA, retain a fixed T3CODE_DEV_AUTH_TOKEN in the launch environment and set browserAuth:"t3-dev" so opening the link renews authentication; never emit the credential. Ordinary QA explicitly selects Default or a dedicated QA profile. GitHub uploads and other authenticated GitHub work explicitly select Logged in Developer in a separate tab after preview_profiles; never change the default profile to obtain a login. Do not substitute a provider background shell, nohup, tmux, a longer timeout, or an external daemon. A link produced without preview_host has no managed server lifetime guarantee. Persistent LastCode-hosted HTML assets can use the existing file-preview path without a temporary server.
</preview_handoffs>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${PREVIEW_HANDOFF_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
