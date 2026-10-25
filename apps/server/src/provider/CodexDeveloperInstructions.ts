import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T3 Code devices

The \`t3-code\` MCP server also exposes \`device_*\` tools for iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in their Device panel; its result explains how to drive the device. Driving happens through the \`agent-device\` CLI, using the exact launcher path returned by \`device_open\`. Keep the host config and session flags returned by \`device_open\` on every command so concurrent devices stay independent: prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device_screenshot\` when you need to see the screen. Prefer these tools and \`agent-device\` for opening and driving devices. Platform tools such as \`xcrun simctl\` and \`adb\` remain available for anything they do not cover, such as builds, logs, or port forwarding. If \`device_list\` reports a platform as unavailable, say so.`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/**
 * Codex retains omitted keys, so unavailable tools need a replacement value
 * that supersedes earlier guidance without steering away from alternatives.
 */
const toolInstructions = (availability: boolean | T3CodeToolAvailability) => {
  const tools = normalizeAvailability(availability);
  // LastCode's browser guidance plus device guidance exceeds the per-entry cap.
  return {
    t3_code_tools_browser: {
      kind: "application" as const,
      value: tools.browser
        ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS
        : "T3 Code browser tools are unavailable in this session. Disregard earlier T3 Code browser-tool guidance and use available alternatives.",
    },
    t3_code_tools_device: {
      kind: "application" as const,
      value: tools.device
        ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS
        : "T3 Code device tools are unavailable in this session. Disregard earlier T3 Code device-tool guidance and use available alternatives.",
    },
  };
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...tools,
  };
}
