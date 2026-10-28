import {
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { randomUUID } from "./lib/utils";
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

export interface ProjectScriptInput {
  readonly name: ProjectScript["name"];
  readonly command: ProjectScript["command"];
  readonly icon: ProjectScript["icon"];
  readonly runOnWorktreeCreate: ProjectScript["runOnWorktreeCreate"];
  readonly waitForSetup: boolean;
  readonly runOnSettle: boolean;
  readonly previewUrl: Exclude<ProjectScript["previewUrl"], undefined> | null;
  readonly autoOpenPreview: boolean;
  readonly allowAgentResume?: boolean;
  readonly terminalLinkProfileName?: string;
}

export function buildProjectScript(id: string, input: ProjectScriptInput): ProjectScript {
  return {
    id,
    name: input.name,
    command: input.command,
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    ...(input.runOnWorktreeCreate && input.waitForSetup ? { async: false } : {}),
    ...(input.runOnSettle ? { runOnSettle: true } : {}),
    ...(input.allowAgentResume ? { allowAgentResume: true } : {}),
    ...(input.terminalLinkProfileName === undefined
      ? {}
      : { terminalLinkProfileName: input.terminalLinkProfileName }),
    ...(input.previewUrl === null
      ? {}
      : {
          previewUrl: input.previewUrl,
          autoOpenPreview: input.autoOpenPreview,
        }),
  };
}

/** Keep Action link intent out of reused shells, including a later ordinary Action. */
export function selectProjectScriptTerminal(input: {
  readonly script: ProjectScript;
  readonly baseTerminalId: string;
  readonly existingTerminalIds?: ReadonlyArray<string>;
  readonly baseTerminalLinkProfileName?: string | undefined;
  readonly pendingTerminalLinkProfiles?: Readonly<Record<string, string>> | undefined;
  readonly isBaseTerminalBusy: boolean;
  readonly preferNewTerminal: boolean;
  readonly canReuseTerminal: boolean;
  readonly canReadTerminal: boolean;
  readonly allocateTerminalId: () => string;
}) {
  const createNewTerminal =
    input.script.terminalLinkProfileName !== undefined ||
    input.baseTerminalLinkProfileName !== undefined ||
    input.pendingTerminalLinkProfiles?.[input.baseTerminalId] !== undefined ||
    input.preferNewTerminal ||
    input.isBaseTerminalBusy ||
    !input.canReuseTerminal ||
    !input.canReadTerminal;
  return {
    createNewTerminal,
    terminalId:
      input.script.terminalLinkProfileName !== undefined
        ? nextTerminalId(input.existingTerminalIds ?? [input.baseTerminalId], randomUUID())
        : createNewTerminal
          ? input.allocateTerminalId()
          : input.baseTerminalId,
    ...(input.script.terminalLinkProfileName === undefined
      ? {}
      : { terminalLinkProfileName: input.script.terminalLinkProfileName }),
  };
}

/**
 * A project runs at most one setup script and one settle script, so saving a
 * script that claims either role takes it from the script that held it.
 */
export function releaseClaimedRoles(
  script: ProjectScript,
  saved: ProjectScriptInput,
): ProjectScript {
  const releaseSetup = saved.runOnWorktreeCreate && script.runOnWorktreeCreate;
  const releaseSettle = saved.runOnSettle && script.runOnSettle === true;
  if (!releaseSetup && !releaseSettle) return script;
  return {
    ...script,
    ...(releaseSetup ? { runOnWorktreeCreate: false } : {}),
    ...(releaseSettle ? { runOnSettle: false } : {}),
  };
}

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function commandForProjectScript(scriptId: string): KeybindingCommand | null {
  const command = `script.${scriptId}.run`;
  return isScriptRunCommand(command) ? command : null;
}

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!isScriptRunCommand(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

export function primaryProjectScript(scripts: ReadonlyArray<ProjectScript>): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate && !script.runOnSettle);
  return regular ?? scripts.find((script) => !script.runOnSettle) ?? null;
}
