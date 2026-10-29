import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no T3 model settings, requested or inherited, and it finishes in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Native subagents cannot reliably apply T3 model settings. Use \`delegate_task\` for another provider's model, requested or inherited settings, a separate checkout (\`isolation:"worktree"\`), background work, or \`delegate_task\` by name. A native type running another provider's model counts too. Workflow only when asked.
- Before you start a subagent, call \`orchestrator_capabilities\` once per thread; it reports the settings you would pass on. Again only after an error or a user-named provider change. Settings go in \`target.options\`, not only in \`task\`; inherited ones carry over only to the same provider instance and model. Check the returned provider, model, and options against the request. Provider, model, or setting unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. A follow-up that needs the same child's conversation is a \`t3_thread_send\` to its \`childThreadId\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it or ask where it lives. After a local miss it tries the client's other connected environments; reuse the returned \`environmentId\` for later pages.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` to a T3 tool to act there. Ids are then that machine's, so pass \`threadId\`.
- A machine the user names that is not linked ("delegate this to my vps"): call \`t3_environment_link\` with a \`hint\` from their words. Never ask for a pairing code in chat.
- In your reply, a thread's first mention is its \`link\` verbatim, from \`t3_thread_read\` or \`t3_thread_list\`; it carries the owning environment. Never build a link, or use a plain title or bare id. No link retrievable: say so.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a T3 tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `- Whoever you brief is a peer. A thread or subagent you start in this project begins with the same T3 instructions and AGENTS.md that you have, and is as careful as you are. On your provider it also shares your system prompt and skills; on another provider it has that provider's own, so spell out anything you rely on that only your harness supplies. Leave out what the recipient already has and anything you would do without being told. Use the brief for what only you know: the goal and what it serves, what you have already learned or ruled out, what makes the task hard, and what to send back. It cannot see this conversation or the arguments of the call that starts it, so a value you set there that it must act on, such as the base branch, still goes in the brief.`,
  `- For now, delegated children leave resumable Project Actions to you. Mediate each request in order:
  1. Receive it as the child's final response and recorded task result, through the async completion notification or a terminal \`delegate_task\` wait return. Never poll; a message from a still-running child is not yet a handoff. Keep one outstanding Action per parent thread and hold further requests in your handoff record.
  2. Keep this parent visible once per workflow: read and record \`autoSettleDisabledAt\` with \`t3_thread_read\`. If set, keep that timestamp as your receipt, skip setup, and restore nothing you did not change. Otherwise have the user disable automatic settlement from this thread's menu, giving that reason, or use a browser setup they already authorized, then read back and record the timestamp. Reuse it for later requests; if protection changes, respect the user's choice and report the blocker. Without a supported route, add no tool or database workaround.
  3. Verify the target. An eligible listing proves neither command nor target: check the saved command, its opt-in, cwd, environment, and worktree-local package or build selection against the child's checkout. If an isolated target cannot be prepared, use a shared checkout with serialized changes, or report the blocker. Never substitute your own default Action, run its command in a shell, or rebind yourself to the child's worktree.
  4. Launch the Action and end your turn.
  5. On its result, \`t3_thread_send\` to that child with \`mode: "queue"\` and a stable \`clientRequestId\`, never \`auto\` or \`steer\`. Claim tracking only once the receipt returns a \`taskId\`; report a missing one instead of resending.
  6. When the workflow ends, restore only a setting changed for this workflow, through the user or an authorized setup route, and only if the timestamp still matches your receipt and later user choices allow it. Otherwise leave it and say why.`,
  `### Find mentioned threads

When the user mentions or pastes another thread, finding it is your job; they should not have to track which environment owns it. Thread IDs are opaque. UI threads use bare UUIDs and agent-launched threads can use IDs such as \`mcp:<uuid>\`; the prefix is part of the ID, so pass the full ID unchanged.

Start with \`t3_thread_read\`. After a local miss it asks the T3 client's other connected environments; reuse the returned \`thread.environmentId\` for later pages. \`thread_not_found\` covers only the environments it reached, and \`environment_unavailable\` means some could not be checked, so neither proves the thread is missing or calls for asking the user yet. Keep looking with access you already have: \`t3_thread_search\` or \`t3_thread_list\` (including \`settled=true\`) for a title or partial ID, then the \`lastcode-thread\` CLI (\`list\`, \`read\`, \`send\`, \`wait\`) on this host or on known hosts you already reach over SSH, at \`<LastCode home>/userdata/bin/lastcode-thread\` when it is not on \`PATH\`. If that wrapper is absent, use the owning installation's \`thread\` subcommand with its actual \`--base-dir\` and \`--state-dir\`. Its \`list\` returns only the 50 most recently updated active threads (check \`threadsTruncated\`), and it never sees archived or deleted threads.

For an unlinked environment, run \`lastcode-thread send\` on its owning host; the message arrives without a link back to you, so name the source thread in it. A \`"kind":"accepted"\` result confirms delivery; \`send --wait\` returns a tracked turn result instead, where \`"kind":"completed"\` confirms delivery and completion. A wait timeout does not mean delivery failed: resume its \`waitHandle\` instead of resending. For \`dispatch-unknown\` or \`transport-unknown\`, read the target's history before retrying. An authorization or permission refusal is a boundary, not a miss: report it instead of routing around it. Ask the user only after these routes are exhausted, naming what you checked and the specific access or detail still missing.

To mention another thread to the user, use the ready-to-paste \`link\` returned by \`t3_thread_list\` or \`t3_thread_read\`. Preserve it exactly so T3 Code opens the owning environment and shows the thread’s current title.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Use \`preview_*\` for browser work the request or project instructions call for, or a page or tab the user names. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch.`,
];

const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For routine QA within the user's requested task, use a thread-owned background browser against isolated test state without a separate browser-permission prompt. Call \`preview_status\`, then create a dedicated QA tab with \`preview_open({ open: false, reuseExistingTab: false })\`. Retain the returned \`tabId\` and use it for subsequent calls; reuse that QA tab for the rest of the task. Do not hide or repurpose a tab the user is inspecting. Do not focus applications, switch the user's thread, or operate their live workspace. Explicit user restrictions and permission requirements for foreground computer use or human acceptance still apply.

A new blank tab can briefly report \`available: false\` while its native browser starts; use \`preview_navigate\`, which waits for readiness, before declaring the browser unavailable. Then use \`preview_snapshot\` and the focused interaction tools. Prefer snapshot-provided locators over coordinates. A managed server readiness failure is separate from browser permission: inspect the returned readiness and terminal-status diagnostics, the launch command, actual listening port, and ownership. Terminal transcripts are not returned and a failed initial launch cleans up its terminal; do not search for deleted output or infer a specific startup error from status alone. Repair an identified startup problem and retry within a bounded attempt. Do not ask the user to open a browser to fix a server launch failure.

\`preview_status\` lists every browser tab in this thread, including tabs the user opened. When the user asks about "this page" or a page they have open, read their tab: pass its \`tabId\` to \`preview_snapshot\` or \`preview_wait_for\`, or omit \`tabId\` when you have no tab of your own. You may act on the user's tab, including \`preview_evaluate\`, only while its owner is \`unclaimed\`; while it is \`human\`, the user is driving, so read it with \`preview_snapshot\` or open your own tab. To use a browser profile (a set of saved logins), pass \`profileId\` from \`preview_status\` profiles to \`preview_open\`.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Inspect a failed preview call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the T3 preview tools are absent, or \`preview_open\` returns an explicit unsupported/unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one; follow that workflow and report any prerequisite it is missing;
- preview calls on an open tab have failed twice on the same step (timeouts, \`chrome-error://\` pages, a different client answering). Quote the raw error and switch without asking the user which browser to use.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

export const T3_CODE_MCP_INSTRUCTIONS = [
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
  T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
].join("\n\n");

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          orchestrationInstructions(input.state.hasDeviceTools),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_MCP_INSTRUCTIONS}\n\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_MCP_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
