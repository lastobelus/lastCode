const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

const PREVIEW_HANDOFF_INSTRUCTIONS = `<preview_handoffs>
When the t3-code MCP server exposes preview_host, launch temporary QA dev servers and HTML servers through that tool before handing the user a link. Supply the exact command, absolute working directory, local URL, required environment overrides, and source worktree path. Keep HTML and its supporting files in the workspace. The tool retains the handoff recipe and source until explicit stop or thread deletion. Its process sleeps after 24 hours; opening the in-thread link or retained Browser panel restores it without another agent turn and starts a fresh run window. Process expiry is not handoff expiry. Do not stop its terminal or delete its files at turn end or while waiting for acceptance. Prepare requested manual QA without asking the user to start a QA window: leave the scenario ready and emit a clean integrated-browser link. For T3 dev QA, retain a fixed T3CODE_DEV_AUTH_TOKEN in the launch environment and set browserAuth:"t3-dev" so opening the link renews authentication; never emit the credential. If a browser fault repeats after a corrected diagnostic attempt, coordinate one investigation with a clear owner; do not repeatedly ask another blocked thread to perform the same QA or ask the user to reconnect an unspecified host. Ordinary QA explicitly selects Default or a dedicated QA profile. GitHub uploads and other authenticated GitHub work explicitly select Logged in Developer in a separate tab after preview_profiles; never change the default profile to obtain a login. Do not substitute a provider background shell, nohup, tmux, a longer timeout, or an external daemon. A link produced without preview_host has no managed server lifetime guarantee. Persistent LastCode-hosted HTML assets can use the existing file-preview path without a temporary server.
</preview_handoffs>`;

/** Omit model and effort when the harness manages them dynamically. */
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
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${PREVIEW_HANDOFF_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
