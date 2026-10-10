/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  DEFAULT_TERMINAL_ID,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalObserveInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { mergePathEntries } from "@t3tools/shared/shell";

import { acpRegistryManagedBinaryDirectories } from "@t3tools/provider-acp-registry/server";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

export type TerminalShellFamily = "posix" | "powershell" | "cmd";

export type OpenTerminalSessionSnapshot = TerminalSessionSnapshot & {
  readonly shellFamily?: TerminalShellFamily;
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const MAX_SUBPROCESS_POLL_INTERVAL_MS = 60_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_PROCESS_EXIT_WAIT_MS = 5_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "resource-monitor"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

export class TerminalShutdownError extends Schema.TaggedError<TerminalShutdownError>()(
  "TerminalShutdownError",
  {
    threadId: Schema.String,
    terminalIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Failed to stop terminals: ${this.terminalIds.join(", ")}.`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same thread/terminal id and restores
     * persisted history on first open.
     */
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<OpenTerminalSessionSnapshot, TerminalError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      startIfNeeded?: boolean,
    ) => Effect.Effect<() => void, TerminalError>;

    /** Observe an existing session without starting or changing its process. */
    readonly observeStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /** Read the persisted transcript without opening or restarting the terminal. */
    readonly history: (input: TerminalClearInput) => Effect.Effect<string, TerminalHistoryError>;

    /**
     * Restart a terminal session in place.
     *
     * Always resets history before spawning the new process.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Close an active terminal session.
     *
     * When `terminalId` is omitted, closes all sessions for the thread.
     */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;
    /** Close and await this thread's terminals without allowing concurrent opens or restarts. */
    readonly shutdownThread: (
      threadId: string,
    ) => Effect.Effect<void, TerminalError | TerminalShutdownError>;
    /** Await already requested process cleanup for this thread and report failed termination. */
    readonly waitForThreadShutdown: (
      threadId: string,
    ) => Effect.Effect<void, TerminalShutdownError>;
    /** Archive cleanup also removes untracked histories, except retained preview terminals. */
    readonly closeThreadExcept: (
      threadId: string,
      retainedTerminalIds: ReadonlyArray<string>,
      retainedTerminalPrefixes?: ReadonlyArray<string>,
    ) => Effect.Effect<void, TerminalError>;

    /**
     * Close a thread's terminals that wait at an idle shell prompt. A terminal
     * that runs a command stays open. When `terminalId` is set, only that
     * terminal is considered. Used when a thread settles and when a setup
     * script finishes.
     */
    readonly closeIdle: (input: {
      readonly threadId: string;
      readonly terminalId?: string;
      readonly excludedTerminalIds?: ReadonlyArray<string>;
    }) => Effect.Effect<void>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /** Read current terminal metadata without subscribing to runtime events. */
    readonly metadata: Effect.Effect<ReadonlyArray<TerminalSummary>>;

    /** Refresh subprocess activity, then read current terminal metadata. */
    readonly refreshMetadata: Effect.Effect<ReadonlyArray<TerminalSummary>>;
  }
>()("t3/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
    spawnedShellName: string | null,
    beforeFirstInput?: boolean,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  /** Counts writes, so closeIdle can see input that has not echoed yet. */
  inputCount: number;
  /** Successful opens/attachments invalidate earlier idle inspections. */
  attachmentGeneration: number;
  /** Queued or executing writes keep automatic cleanup away from the terminal. */
  pendingInputCount: number;
  /** Reservations preserve input order independently of thread-lock scheduling. */
  inputWaiters: Array<Deferred.Deferred<void>>;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Normalized active command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  shellFamily: TerminalShellFamily | null;
  /** Configured or observed startup identity, frozen before the first input. */
  spawnedShellName: string | null;
  /** Shared capture freezes startup identity before concurrent first writes. */
  captureShellIdentity: Effect.Effect<void> | null;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  history: BoundedTerminalHistory;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      history: BoundedTerminalHistory | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminatingProcess {
  readonly terminal: TerminalSummary;
  readonly exited: Deferred.Deferred<void>;
}

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, never>>;
  terminatingProcesses: Map<PtyAdapter.PtyProcess, TerminatingProcess>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  // Login shells may appear in the process table with a leading dash.
  const normalized =
    platform === "win32"
      ? base.toLowerCase().endsWith(".exe")
        ? base.slice(0, -4)
        : base
      : base.replace(/^-/, "");
  return normalized.length > 0 ? normalized : null;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history.value(),
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
  };
}

function openSnapshot(session: TerminalSessionState): OpenTerminalSessionSnapshot {
  return {
    ...snapshot(session),
    ...(session.shellFamily === null ? {} : { shellFamily: session.shellFamily }),
  };
}

function publicSnapshot(snapshot: OpenTerminalSessionSnapshot): TerminalSessionSnapshot {
  const { shellFamily: _shellFamily, ...terminalSnapshot } = snapshot;
  return terminalSnapshot;
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function shellFamilyForCommand(command: string, platform: NodeJS.Platform): TerminalShellFamily {
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (
    shellName === "pwsh" ||
    shellName === "pwsh.exe" ||
    shellName === "powershell" ||
    shellName === "powershell.exe"
  ) {
    return "powershell";
  }
  if (shellName === "cmd" || shellName === "cmd.exe") return "cmd";
  return "posix";
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

export function subprocessSnapshotPollDelayMs(
  pollIntervalMs: number,
  failureCount: number,
): number {
  return Math.min(pollIntervalMs * 2 ** failureCount, MAX_SUBPROCESS_POLL_INTERVAL_MS);
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // `comm=` is the final column and may itself contain spaces, so only the
    // first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function processTableSnapshotFromProcesses(
  processes: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const process of processes) {
    const { pid, ppid: parentPid, name } = process;
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, name.trim());
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

function startupShellIdentity(
  observedName: string | null,
  spawnedShellName: string | null,
  platform: NodeJS.Platform,
): string | null {
  // A truncated Linux name cannot distinguish a long shell from another
  // executable with the same prefix. Preserve that ambiguity as active.
  if (
    observedName === null ||
    (platform === "linux" &&
      spawnedShellName !== null &&
      observedName !== spawnedShellName &&
      (Buffer.byteLength(observedName) === 15 ||
        (Buffer.byteLength(spawnedShellName) > 15 &&
          observedName === Buffer.from(spawnedShellName).subarray(0, 15).toString("utf8"))))
  ) {
    return spawnedShellName;
  }
  return observedName;
}

function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
  spawnedShellName: string | null,
  beforeFirstInput = false,
): TerminalSubprocessInspectResult {
  const commandName = (pid: number) =>
    normalizeChildCommandName(snapshot.commandById.get(pid) ?? "", platform);
  const shellName = commandName(terminalPid);
  // POSIX exec replaces the shell while retaining the PTY root PID. It can
  // run real work without any child processes. Linux comm can truncate names
  // to 15 bytes, so matching a long shell's truncated prefix cannot prove it
  // is still the shell. Keep ambiguous roots active until a full name matches.
  const shellIdentity = beforeFirstInput
    ? startupShellIdentity(shellName, spawnedShellName, platform)
    : spawnedShellName;
  const rootWasReplaced =
    platform !== "win32" &&
    shellIdentity !== null &&
    shellName !== null &&
    (shellName !== shellIdentity || (platform === "linux" && Buffer.byteLength(shellName) === 15));
  // Async prompt themes fork the shell into a helper that waits with no
  // children of its own. That copy is not a command the user started.
  const childPid = (snapshot.childrenByParent.get(terminalPid) ?? []).find(
    (pid) =>
      shellName === null ||
      commandName(pid) !== shellName ||
      (snapshot.childrenByParent.get(pid)?.length ?? 0) > 0,
  );
  const activePid = rootWasReplaced ? terminalPid : childPid;
  if (activePid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }
  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      pending.push(pid);
    }
  }
  const normalized = commandName(activePid);
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve `ps` to an absolute path once at startup. Spawning by bare name
// walks every PATH entry per spawn (one failed posix_spawn per directory
// until the hit), which is measurable at a 1s poll cadence on long PATHs.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout: "1 second",
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Not authoritative: an empty or partial table would mark every terminal
    // idle and clear its registered process ids. Failing skips the tick.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(
  function* (): Effect.fn.Return<
    TerminalProcessTableSnapshot,
    TerminalSubprocessCheckError,
    ProcessRunner.ProcessRunner
  > {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const command =
      'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
    const result = yield* processRunner
      .run({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        timeout: "1500 millis",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) => new TerminalSubprocessCheckError({ cause, command: "powershell" }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return yield* new TerminalSubprocessCheckError({
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    const processes = result.stdout.split(/\r?\n/g).flatMap((line) => {
      const [pidRaw, ppidRaw, name = ""] = line.trim().split("|", 3);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)
        ? [{ pid, ppid, name }]
        : [];
    });
    return processTableSnapshotFromProcesses(processes);
  },
);

interface TerminalHistoryChunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      // Preserve the existing zero-line limit's trailing newline behavior.
      if (this.maxBytes > 0 && text.endsWith("\n")) this.appendChunk("\n");
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    let lineBreaks = 0;
    for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
      lineBreaks += 1;
    }
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        // ASCII without newlines needs no scan to find the byte cutoff.
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      // Scan only the discarded prefix of one small chunk, never all history.
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => chunk!.data)
      .join("");
    return this.cachedValue;
  }
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content) || content.startsWith("777;T3ActionEvent;");
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Base64Url.encode(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Base64Url.encode(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// Colon-separated search-path variables the AppImage runtime points at its
// temporary mount (e.g. /tmp/.mount_T3-XXXX/usr/bin, the bundled glib schemas,
// and an $APPDIR/usr/share XDG data entry). Only the mount segments are
// dropped; the user's real entries are preserved. When nothing but mount
// segments remain the variable is removed entirely so consumers fall back to
// their platform default (e.g. gsettings finds the host schemas instead of
// reporting "No schemas installed"). See issues #1699 and #5059.
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv: Record<string, string> | null | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      const existingKey =
        platform === "win32"
          ? Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
          : undefined;
      spawnEnv[existingKey ?? key] =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value) : value;
    }
  }
  // An explicit empty override opts out for terminals started without a client.
  // Otherwise both PTY backends feed truecolor-capable terminal clients.
  if (!spawnEnv.COLORTERM && runtimeEnv?.COLORTERM === undefined) {
    spawnEnv.COLORTERM = "truecolor";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  localCiSettingsPath?: string;
  /**
   * Catalog cache and tool directories for managed ACP Registry installs. Their
   * install directories are appended to the terminal PATH so users can run
   * managed agents by name (e.g. `kimi login`).
   */
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
  subprocessInspector?: TerminalSubprocessInspector;
  processTable?: Effect.Effect<
    ReadonlyArray<ResourceMonitorProcessTableEntry>,
    TerminalSubprocessCheckError
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  processExitWaitMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  resolveProviderInstanceEnvironment?: (
    providerInstanceId: string,
    env: Record<string, string> | undefined,
  ) => Effect.Effect<
    Record<string, string>,
    TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
  >;
}

export const resolveProviderInstanceTerminalEnvironment = Effect.fn(
  "terminal.resolveProviderInstanceTerminalEnvironment",
)(function* (input: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly rawProviderInstanceId: string;
  readonly env: Record<string, string> | undefined;
}) {
  const providerInstanceId = ProviderInstanceId.make(input.rawProviderInstanceId);
  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new TerminalProviderEnvironmentError({ providerInstanceId, cause })),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
  if (instance === undefined) {
    return yield* new TerminalProviderInstanceNotFoundError({ providerInstanceId });
  }

  let resolved = mergeProviderInstanceEnvironment(instance.environment, input.env ?? {});
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      const layout = yield* resolveCodexHomeLayout(config.value).pipe(
        Effect.provideService(Path.Path, input.path),
      );
      if (layout.effectiveHomePath)
        resolved = { ...resolved, CODEX_HOME: layout.effectiveHomePath };
    }
  } else if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      resolved = yield* makeClaudeEnvironment(config.value, resolved).pipe(
        Effect.provideService(Path.Path, input.path),
      );
    }
  }

  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir, providerStatusCacheDir, baseDir, settingsPath } =
    yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const resolveProviderInstanceEnvironment = Effect.fn(
    "terminal.resolveProviderInstanceEnvironment",
  )((rawProviderInstanceId: string, env: Record<string, string> | undefined) =>
    resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId,
      env,
    }),
  );
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    localCiSettingsPath: settingsPath,
    ptyAdapter,
    processTable: nativeTelemetry.processTable.pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "resource-monitor" }),
      ),
    ),
    managedBinaryCacheDir: providerStatusCacheDir,
    managedBinaryToolsDir: path.join(baseDir, "tools"),
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    resolveProviderInstanceEnvironment,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolveLaunchInputEnvironment = Effect.fn("terminal.resolveLaunchInputEnvironment")(
    function* <Input extends TerminalOpenInput | TerminalAttachInput | TerminalRestartInput>(
      input: Input,
    ): Effect.fn.Return<
      Input,
      TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
    > {
      if (input.providerInstanceId === undefined) return input;
      const resolver = options.resolveProviderInstanceEnvironment;
      if (resolver === undefined) {
        return yield* new TerminalProviderInstanceNotFoundError({
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        });
      }
      const env = yield* resolver(input.providerInstanceId, input.env);
      return { ...input, env };
    },
  );
  // One process-table snapshot per poll tick, shared across every terminal.
  // Per-terminal `pgrep`/`ps` calls multiply spawn load by terminal count and
  // can exhaust the PID space on hosts with many sessions (#6332).
  const fallbackProcessTableSnapshot = (
    platform === "win32"
      ? windowsProcessTableSnapshot()
      : posixProcessTableSnapshot(yield* resolvePosixPsCommand())
  ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  const processTableSnapshot: Effect.Effect<
    {
      readonly snapshot: TerminalProcessTableSnapshot;
      /**
       * False when the sidecar snapshot failed and this table came from the
       * spawned fallback. The data is still applied, but the tick counts as
       * a failure so polling backs off instead of hot-looping the fallback.
       */
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > = options.processTable
    ? options.processTable.pipe(
        Effect.map((entries) => ({
          snapshot: processTableSnapshotFromProcesses(entries),
          snapshotSucceeded: true,
        })),
        Effect.catch(() =>
          fallbackProcessTableSnapshot.pipe(
            Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: false })),
          ),
        ),
      )
    : fallbackProcessTableSnapshot.pipe(
        Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: true })),
      );
  // Share overlapping requests only until a spawn, write, or output changes activity.
  // Replacing the cache keeps new callers out of a pre-change scan; its older
  // callers can still finish or interrupt it when the last waiter leaves.
  let sharedProcessTableSnapshot: typeof processTableSnapshot | undefined;
  const fetchProcessTableSnapshot = Effect.suspend(() => {
    if (sharedProcessTableSnapshot !== undefined) return sharedProcessTableSnapshot;
    return Effect.cachedWithTTL(processTableSnapshot, 0).pipe(
      Effect.flatMap((cached) => {
        sharedProcessTableSnapshot = cached;
        return cached;
      }),
    );
  });
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector: Effect.Effect<
    {
      readonly inspector: TerminalSubprocessInspector;
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > =
    customSubprocessInspector !== undefined
      ? Effect.succeed({ inspector: customSubprocessInspector, snapshotSucceeded: true })
      : Effect.map(
          fetchProcessTableSnapshot,
          ({
            snapshot,
            snapshotSucceeded,
          }): {
            readonly inspector: TerminalSubprocessInspector;
            readonly snapshotSucceeded: boolean;
          } => ({
            inspector: (terminalPid, spawnedShellName, beforeFirstInput) =>
              Effect.succeed(
                deriveSubprocessInspectResult(
                  snapshot,
                  terminalPid,
                  platform,
                  spawnedShellName,
                  beforeFirstInput,
                ),
              ),
            snapshotSucceeded,
          }),
        );
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const processExitWaitMs = options.processExitWaitMs ?? DEFAULT_PROCESS_EXIT_WAIT_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
    terminatingProcesses: new Map(),
  });
  const threadLocks = yield* KeyedLock.make<string>();
  // Includes queued Stops and remains active through thread-lock finalization.
  const pendingThreadShutdowns = new Map<string, number>();
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const terminalMetadataListeners = new Set<
    (event: TerminalMetadataStreamEvent) => Effect.Effect<void>
  >();
  const metadataDeliveryLock = yield* Semaphore.make(1);
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent = (event: TerminalEvent) =>
    Effect.gen(function* () {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
      if (shouldPublishTerminalMetadataEvent(event)) {
        yield* publishMetadataUpdate(event);
      }
    });

  const historyPath = (threadId: string, terminalId: string) => {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(logsDir, `${threadPart}.log`);
    }
    return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  };

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => threadLocks.withLock(threadId, effect);

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
    retainedExit?: Deferred.Deferred<void>,
  ): Effect.fn.Return<boolean> {
    const observedExit =
      retainedExit ?? (yield* readManagerState).terminatingProcesses.get(process)?.exited;
    const exited = observedExit ?? (yield* Deferred.make<void>());
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        observedExit !== undefined
          ? () => {}
          : process.onExit(() => {
              Deferred.doneUnsafe(exited, Effect.void);
            }),
      ),
      () =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(exited)) return true;

          const signal = (name: "SIGTERM" | "SIGKILL") =>
            Effect.try({
              try: () => process.kill(name),
              catch: (cause) =>
                new TerminalProcessSignalError({
                  cause,
                  signal: name,
                  terminalPid: process.pid,
                }),
            }).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning("failed to kill terminal process", {
                  threadId,
                  terminalId,
                  signal: name,
                  cause: error,
                }).pipe(Effect.as(false)),
              ),
            );

          if (!(yield* signal("SIGTERM"))) return yield* Deferred.isDone(exited);
          if (yield* Deferred.isDone(exited)) return true;
          const gracefulExit = yield* Deferred.await(exited).pipe(
            Effect.timeoutOption(processKillGraceMs),
          );
          if (Option.isSome(gracefulExit) || (yield* Deferred.isDone(exited))) return true;

          if (!(yield* signal("SIGKILL"))) return yield* Deferred.isDone(exited);
          if (yield* Deferred.isDone(exited)) return true;
          const forcedExit = yield* Deferred.await(exited).pipe(
            Effect.timeoutOption(processExitWaitMs),
          );
          if (Option.isSome(forcedExit) || (yield* Deferred.isDone(exited))) return true;
          yield* Effect.logWarning("terminal process exit was not confirmed", {
            threadId,
            terminalId,
            terminalPid: process.pid,
          });
          return false;
        }),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
  });

  const completeProcessShutdown = Effect.fn("terminal.completeProcessShutdown")(function* (
    process: PtyAdapter.PtyProcess,
  ): Effect.fn.Return<void> {
    const terminal = yield* modifyManagerState((state) => {
      const terminating = state.terminatingProcesses.get(process);
      if (terminating === undefined) return [undefined, state] as const;
      const terminatingProcesses = new Map(state.terminatingProcesses);
      terminatingProcesses.delete(process);
      return [terminating.terminal, { ...state, terminatingProcesses }] as const;
    });
    if (terminal !== undefined) yield* publishMetadataUpdate(terminal);
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const existing = (yield* readManagerState).killFibers.get(process);
    if (existing !== undefined && existing.pollUnsafe() === undefined) return;

    const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
      Effect.tap((completed) => (completed ? completeProcessShutdown(process) : Effect.void)),
      Effect.asVoid,
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      yield* fileSystem
        .writeFileString(historyPath(threadId, terminalId), request.history.value())
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
    }),
  });

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    const limit = BigInt(historyByteLimit);
    const offset = info.size > limit ? info.size - limit : 0n;
    yield* file.seek(offset, "start");
    const bytes = new Uint8Array(Number(info.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    let start = 0;
    if (offset > 0n) {
      // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
      while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return {
      history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
      truncated: offset > 0n,
    };
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        )
    ) {
      const { history: raw, truncated } = yield* readHistoryTail(nextPath).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
        ),
      );
      const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
      const capped = history.value();
      if (truncated || capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", threadId, terminalId, cause }),
            ),
          );
      }
      return history;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
    }

    const legacyPath = legacyHistoryPath(threadId);
    if (
      !(yield* fileSystem
        .exists(legacyPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
          ),
        ))
    ) {
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
    }

    const { history: raw } = yield* readHistoryTail(legacyPath).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) => new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
      ),
    );
    const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
    const capped = history.value();
    yield* fileSystem
      .writeFileString(nextPath, capped)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    yield* fileSystem.remove(legacyPath, { force: true }).pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError,
        }),
      ),
    );
    return history;
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
    if (terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
    retainedTerminalIds: ReadonlyArray<string> = [],
    retainedTerminalPrefixes: ReadonlyArray<string> = [],
  ) {
    const retainedPaths = new Set(
      retainedTerminalIds.flatMap((terminalId) => [
        historyPath(threadId, terminalId),
        ...(terminalId === DEFAULT_TERMINAL_ID ? [legacyHistoryPath(threadId)] : []),
      ]),
    );
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    const retainedByPrefix = (name: string) => {
      if (
        retainedTerminalPrefixes.length === 0 ||
        !name.startsWith(threadPrefix) ||
        !name.endsWith(".log")
      )
        return false;
      const decoded = Base64Url.decodeString(name.slice(threadPrefix.length, -4));
      return (
        decoded._tag === "Success" &&
        retainedTerminalPrefixes.some((prefix) => decoded.success.startsWith(prefix))
      );
    };
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          !retainedPaths.has(path.join(logsDir, name)) &&
          !retainedByPrefix(name) &&
          (name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix)),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Effect.fromOption(session, () => new TerminalSessionLookupError({ threadId, terminalId })),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          (session) => session.status !== "running",
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.threadId, session.terminalId);
          sessions.delete(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history.append(sanitized.visibleText);
          }
          // Output can prove a command started after an unfinished scan sampled it.
          sharedProcessTableSnapshot = undefined;
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: nextEvent.data,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* unregisterTerminal({
        threadId: action.threadId,
        terminalId: action.terminalId,
      });
      yield* publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const exited = yield* Deferred.make<void>();
        // Keep an exit witness after detaching the session, including between
        // failed cleanup attempts. A late exit also clears the visible blocker.
        const unsubscribe = process.onExit(() => {
          Deferred.doneUnsafe(exited, Effect.void);
        });
        yield* modifyManagerState((state) => {
          const terminatingProcesses = new Map(state.terminatingProcesses);
          terminatingProcesses.set(process, {
            terminal: {
              ...summary(session),
              status: "running",
              hasRunningSubprocess: true,
            },
            exited,
          });
          cleanupProcessHandles(session);
          session.process = null;
          session.pid = null;
          session.hasRunningSubprocess = false;
          session.childCommandLabel = null;
          session.status = "exited";
          session.pendingHistoryControlSequence = "";
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          session.updatedAt = updatedAt;
          return [undefined, { ...state, terminatingProcesses }] as const;
        });
        yield* restore(Deferred.await(exited)).pipe(
          Effect.andThen(completeProcessShutdown(process)),
          Effect.ensuring(Effect.sync(unsubscribe)),
          Effect.forkIn(workerScope),
        );
      }),
    );

    yield* clearKillFiber(process);
    yield* unregisterTerminal({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    yield* startKillEscalation(process, session.threadId, session.terminalId);
    yield* evictInactiveSessionsIfNeeded();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    {
      process: PtyAdapter.PtyProcess;
      shellLabel: string;
      shellFamily: TerminalShellFamily;
      shellName: string | null;
    },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
        shellFamily: shellFamilyForCommand(candidate.shell, platform),
        shellName: normalizeChildCommandName(
          basenameForPlatform(candidate.shell, platform),
          platform,
        ),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.shellFamily = null;
      session.spawnedShellName = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;
    let startedShellFamily: TerminalShellFamily | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv, platform);
            if (options.localCiSettingsPath !== undefined) {
              terminalEnv.T3CODE_LOCAL_CI_SETTINGS_PATH = options.localCiSettingsPath;
            }
            // Append (never prepend) managed ACP agent install directories so
            // `kimi login` and friends resolve by name without shadowing any
            // system or user tool of the same name.
            if (
              options.managedBinaryCacheDir !== undefined &&
              options.managedBinaryToolsDir !== undefined
            ) {
              const managedDirectories = yield* acpRegistryManagedBinaryDirectories({
                cacheDir: options.managedBinaryCacheDir,
                toolsDir: options.managedBinaryToolsDir,
                platform,
                architecture,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              );
              if (managedDirectories.length > 0) {
                const delimiter = platform === "win32" ? ";" : ":";
                const pathKey =
                  platform === "win32"
                    ? (Object.keys(terminalEnv).find(
                        (candidate) => candidate.toLowerCase() === "path",
                      ) ?? "PATH")
                    : "PATH";
                const merged = mergePathEntries(
                  terminalEnv[pathKey],
                  managedDirectories.join(delimiter),
                  platform,
                );
                if (merged !== undefined) {
                  terminalEnv[pathKey] = merged;
                }
              }
            }
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
            sharedProcessTableSnapshot = undefined;
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;
            startedShellFamily = spawnResult.shellFamily;

            const processPid = ptyProcess.pid;
            const captureShellIdentity =
              platform === "win32" || customSubprocessInspector !== undefined
                ? null
                : yield* Effect.cached(
                    fetchProcessTableSnapshot.pipe(
                      Effect.map(({ snapshot }) =>
                        startupShellIdentity(
                          normalizeChildCommandName(
                            snapshot.commandById.get(processPid) ?? "",
                            platform,
                          ),
                          spawnResult.shellName,
                          platform,
                        ),
                      ),
                      // Identity is best effort; never hold typing behind the
                      // resource monitor's health timeout and fallback probe.
                      Effect.timeoutOption("100 millis"),
                      Effect.map(Option.getOrElse(() => spawnResult.shellName)),
                      Effect.orElseSucceed(() => spawnResult.shellName),
                      Effect.flatMap((identity) =>
                        Effect.sync(() => {
                          if (session.process !== spawnResult.process) return;
                          session.spawnedShellName = identity;
                        }),
                      ),
                    ),
                  );
            let eventsActivated = false;

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              session.spawnedShellName = spawnResult.shellName;
              session.captureShellIdentity = captureShellIdentity;
              // onExit may replay an exit immediately; accept it before subscribing.
              session.unsubscribeData = spawnResult.process.onData((data) => {
                if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
              session.unsubscribeExit = spawnResult.process.onExit((event) => {
                if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
              session.shellFamily = startedShellFamily;
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            yield* publishEvent({
              type: eventType,
              threadId: session.threadId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              snapshot: snapshot(session),
            });
            // Publish startup before draining any events replayed during subscription.
            eventsActivated = true;
            if (session.processEventDrainRunning) runFork(drainProcessEvents(session, processPid));
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.shellFamily = null;
        session.spawnedShellName = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ threadId, terminalId });
      yield* persistHistory(threadId, terminalId, session.value.history);
    }

    yield* flushPersist(threadId, terminalId);

    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
        deleteHistory: deleteHistoryOnClose,
      });
    }

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return true;
    }

    const inspectorOption = yield* acquireSubprocessInspector.pipe(
      Effect.asSome,
      Effect.catch((reason) =>
        Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
          reason,
        }).pipe(
          Effect.as(
            Option.none<{
              readonly inspector: TerminalSubprocessInspector;
              readonly snapshotSucceeded: boolean;
            }>(),
          ),
        ),
      ),
    );

    if (Option.isNone(inspectorOption)) {
      return false;
    }

    const { inspector: subprocessInspector, snapshotSucceeded } = inspectorOption.value;

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & { pid: number },
    ) {
      const terminalPid = session.pid;
      const inspectResult = yield* subprocessInspector(
        terminalPid,
        session.spawnedShellName,
        session.captureShellIdentity !== null,
      ).pipe(
        Effect.asSome,
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (Option.isNone(inspectResult)) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            threadId: liveSession.value.threadId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
    return snapshotSucceeded;
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  let subprocessSnapshotFailureCount = 0;
  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap((snapshotSucceeded) => {
                subprocessSnapshotFailureCount = snapshotSucceeded
                  ? 0
                  : Math.min(subprocessSnapshotFailureCount + 1, 30);
                const delayMs = subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                );
                return Effect.sleep(delayMs);
              }),
            )
          : Effect.sync(() => {
              subprocessSnapshotFailureCount = 0;
            }).pipe(Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs))),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const { sessions, terminatingProcesses } = yield* modifyManagerState(
        (state) =>
          [
            {
              sessions: [...state.sessions.values()],
              terminatingProcesses: [...state.terminatingProcesses.entries()],
            },
            {
              ...state,
              sessions: new Map(),
              terminatingProcesses: new Map(),
            },
          ] as const,
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        cleanupProcessHandles(session);
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, session.threadId, session.terminalId);
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Effect.forEach(
        terminatingProcesses,
        ([process, { terminal, exited }]) =>
          clearKillFiber(process).pipe(
            Effect.andThen(
              runKillEscalation(process, terminal.threadId, terminal.terminalId, exited),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openWithWorkspaceLease = Effect.fn("terminal.openLocked")(function* (
    input: TerminalOpenInput,
  ) {
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.threadId, terminalId);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const history = yield* readHistory(input.threadId, terminalId);
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        inputCount: 0,
        attachmentGeneration: 0,
        pendingInputCount: 0,
        inputWaiters: [],
        cols,
        rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        shellFamily: null,
        spawnedShellName: null,
        captureShellIdentity: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };

      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return openSnapshot(session);
    }

    const liveSession = existing.value;
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return openSnapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
      liveSession.cols = targetCols;
      liveSession.rows = targetRows;
      liveSession.updatedAt = yield* nowIso;
    }

    liveSession.attachmentGeneration += 1;
    return openSnapshot(liveSession);
  });

  const openLocked = (input: TerminalOpenInput) =>
    withWorkspaceLease(
      path.resolve(input.worktreePath ?? input.cwd),
      openWithWorkspaceLease(input),
    );

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(Effect.flatMap(openLocked)),
    );

  const openOrAttachForStream = Effect.fn("terminal.openOrAttachForStream")(function* (
    input: TerminalAttachInput,
    startIfNeeded = true,
  ): Effect.fn.Return<TerminalSessionSnapshot, TerminalError> {
    const observed = yield* Effect.sync(() => {
      const state = SynchronizedRef.getUnsafe(managerStateRef);
      const session = state.sessions.get(toSessionKey(input.threadId, input.terminalId));
      return {
        session,
        terminating:
          pendingThreadShutdowns.has(input.threadId) ||
          ((session === undefined || session.process === null) &&
            [...state.terminatingProcesses.values()].some(
              ({ terminal, exited }) =>
                terminal.threadId === input.threadId &&
                terminal.terminalId === input.terminalId &&
                !Deferred.isDoneUnsafe(exited),
            )),
      };
    });
    return yield* withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const existing = yield* getSession(input.threadId, terminalId);

        // A queued attachment belongs to the lifecycle it observed before
        // waiting, even if Stop has removed its metadata by lock acquisition.
        if (
          observed.terminating ||
          (observed.session !== undefined &&
            (Option.isNone(existing) || existing.value !== observed.session))
        ) {
          return yield* new TerminalNotRunningError({
            threadId: input.threadId,
            terminalId,
          });
        }

        if (Option.isNone(existing) || existing.value.process === null) {
          const terminating = (yield* readManagerState).terminatingProcesses.values();
          // Retained metadata keeps Stop available; mounting its viewport must
          // not turn a closed session back into a new process before exit.
          if (
            [...terminating].some(
              ({ terminal, exited }) =>
                terminal.threadId === input.threadId &&
                terminal.terminalId === terminalId &&
                !Deferred.isDoneUnsafe(exited),
            )
          ) {
            return yield* new TerminalNotRunningError({
              threadId: input.threadId,
              terminalId,
            });
          }
        }

        if (Option.isNone(existing)) {
          if (!input.cwd || !startIfNeeded) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId,
            });
          }

          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          return yield* openLocked(resolvedInput).pipe(Effect.map(publicSnapshot));
        }

        const session = existing.value;
        const targetCols = input.cols ?? session.cols;
        const targetRows = input.rows ?? session.rows;

        if (!session.process && input.cwd && input.restartIfNotRunning === true && startIfNeeded) {
          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          return yield* openLocked(resolvedInput).pipe(Effect.map(publicSnapshot));
        }

        if (
          session.process &&
          session.status === "running" &&
          (session.cols !== targetCols || session.rows !== targetRows)
        ) {
          const process = session.process;
          yield* resizePtyProcess(session, process, targetCols, targetRows);
          session.cols = targetCols;
          session.rows = targetRows;
          session.updatedAt = yield* nowIso;
        }

        session.attachmentGeneration += 1;
        return snapshot(session);
      }),
    );
  });

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) => {
        const terminals = new Map(
          [...state.sessions.values()].map((session) => [
            toSessionKey(session.threadId, session.terminalId),
            summary(session),
          ]),
        );
        for (const { terminal } of state.terminatingProcesses.values()) {
          terminals.set(toSessionKey(terminal.threadId, terminal.terminalId), terminal);
        }
        return [...terminals.values()].sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );
      }),
    );

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    readManagerState.pipe(
      Effect.map((state) => {
        const terminating = [...state.terminatingProcesses.values()].findLast(
          ({ terminal }) =>
            terminal.threadId === input.threadId && terminal.terminalId === input.terminalId,
        );
        if (terminating !== undefined) return terminating.terminal;
        const session = state.sessions.get(toSessionKey(input.threadId, input.terminalId));
        return session === undefined ? null : summary(session);
      }),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const streamSession = (
    input: TerminalObserveInput,
    initial: Effect.Effect<TerminalSessionSnapshot, TerminalError>,
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
  ) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      const initialSnapshot = yield* initial;

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });

      for (const event of bufferedEvents) {
        if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const attachStream: TerminalManager["Service"]["attachStream"] = (
    input,
    listener,
    startIfNeeded,
  ) => streamSession(input, openOrAttachForStream(input, startIfNeeded), listener);

  const observeStream: TerminalManager["Service"]["observeStream"] = (input, listener) =>
    streamSession(
      input,
      withThreadLock(
        input.threadId,
        requireSession(input.threadId, input.terminalId).pipe(Effect.map(snapshot)),
      ),
      listener,
    );

  const publishMetadataUpdate = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }): Effect.Effect<void> =>
    metadataDeliveryLock.withPermit(
      Effect.gen(function* () {
        // Read after acquiring the delivery lock: a completed kill must not be
        // followed by an older close update that restores its retained summary.
        const terminal = yield* readTerminalMetadata(input);
        const event: TerminalMetadataStreamEvent = terminal
          ? { type: "upsert", terminal }
          : { type: "remove", threadId: input.threadId, terminalId: input.terminalId };
        for (const listener of terminalMetadataListeners) {
          yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
        }
      }),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) =>
    metadataDeliveryLock.withPermit(
      Effect.gen(function* () {
        const terminals = yield* readAllTerminalMetadata();
        yield* listener({ type: "snapshot", terminals });
        terminalMetadataListeners.add(listener);
        return () => {
          terminalMetadataListeners.delete(listener);
        };
      }),
    );

  const writeToSession = Effect.fn("terminal.writeToSession")(function* (
    input: TerminalWriteInput,
    session: TerminalSessionState,
    expectedProcess: TerminalSessionState["process"],
  ) {
    const terminalId = input.terminalId;
    const process = session.process;
    // A queued chunk belongs to the process that accepted its reservation.
    // Restart or a context-changing open must not forward it to a new shell.
    if (process !== expectedProcess) {
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    }
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    const captureShellIdentity = session.captureShellIdentity;
    if (captureShellIdentity !== null) yield* captureShellIdentity;
    if (session.process !== process || session.status !== "running") {
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    }
    yield* Effect.try({
      try: () => {
        process.write(input.data);
        sharedProcessTableSnapshot = undefined;
        // Complete forwarding and the gate transition synchronously: a writer
        // canceled after sending its bytes must not look like untouched input.
        if (
          captureShellIdentity !== null &&
          session.process === process &&
          session.captureShellIdentity === captureShellIdentity
        ) {
          session.captureShellIdentity = null;
        }
      },
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    const session = yield* requireSession(input.threadId, input.terminalId);
    const process = session.process;
    // Record requested input before queuing for the lock: an idle check can
    // already be running, or acquire the lock before this write does.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        session.inputCount += 1;
        session.pendingInputCount += 1;
        const waiter = Deferred.makeUnsafe<void>();
        session.inputWaiters.push(waiter);
        if (session.inputWaiters.length === 1) Deferred.doneUnsafe(waiter, Effect.void);
        return waiter;
      }),
      (waiter) =>
        Effect.gen(function* () {
          const captureShellIdentity = session.captureShellIdentity;
          if (captureShellIdentity === null) {
            yield* Deferred.await(waiter);
            return yield* writeToSession(input, session, process);
          }
          // Start each terminal's capture before the thread lock serializes
          // writes, so terminals in one thread share the same pending scan.
          // Keep queuing input immediately; the child ends with this request.
          const captureFiber = yield* captureShellIdentity.pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          return yield* Deferred.await(waiter).pipe(
            Effect.andThen(
              withThreadLock(
                input.threadId,
                requireSession(input.threadId, input.terminalId).pipe(
                  Effect.flatMap((current) => writeToSession(input, current, process)),
                ),
              ),
            ),
            Effect.ensuring(Fiber.interrupt(captureFiber)),
          );
        }),
      (waiter) =>
        Effect.sync(() => {
          session.pendingInputCount -= 1;
          const index = session.inputWaiters.indexOf(waiter);
          session.inputWaiters.splice(index, 1);
          if (index === 0 && session.inputWaiters[0] !== undefined) {
            Deferred.doneUnsafe(session.inputWaiters[0], Effect.void);
          }
        }),
    );
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.threadId, input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withThreadLock(input.threadId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.threadId, terminalId);
        session.history.clear();
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          sequence: eventStamp.sequence,
        });
      }),
    );

  const restartResolved = (input: TerminalRestartInput) =>
    Effect.gen(function* () {
      yield* increment(terminalRestartsTotal, { scope: "thread" });
      const terminalId = input.terminalId;
      yield* assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, terminalId);
      const existingSession = yield* getSession(input.threadId, terminalId);
      let session: TerminalSessionState;
      if (Option.isNone(existingSession)) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        session = {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "starting",
          pid: null,
          history: new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
          pendingHistoryControlSequence: "",
          pendingProcessEvents: [],
          pendingProcessEventIndex: 0,
          processEventDrainRunning: false,
          exitCode: null,
          exitSignal: null,
          updatedAt: yield* nowIso,
          eventSequence: 0,
          inputCount: 0,
          attachmentGeneration: 0,
          pendingInputCount: 0,
          inputWaiters: [],
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          childCommandLabel: null,
          shellFamily: null,
          spawnedShellName: null,
          captureShellIdentity: null,
          runtimeEnv: normalizedRuntimeEnv(input.env),
        };
        const createdSession = session;
        yield* modifyManagerState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(sessionKey, createdSession);
          return [undefined, { ...state, sessions }] as const;
        });
        yield* evictInactiveSessionsIfNeeded();
      } else {
        session = existingSession.value;
        yield* stopProcess(session);
        session.cwd = input.cwd;
        session.worktreePath = input.worktreePath ?? null;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
      }

      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      session.history.clear();
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      yield* persistHistory(input.threadId, terminalId, session.history);
      yield* startSession(
        session,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "restarted",
      );
      return snapshot(session);
    });

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(
        Effect.flatMap((resolved) =>
          withWorkspaceLease(
            path.resolve(resolved.worktreePath ?? resolved.cwd),
            restartResolved(resolved),
          ),
        ),
      ),
    );

  const closeUnlocked = (
    input: TerminalCloseInput,
    retainedTerminalIds: ReadonlyArray<string> = [],
    retainedTerminalPrefixes: ReadonlyArray<string> = [],
  ): Effect.Effect<void, TerminalError> =>
    Effect.gen(function* () {
      // Failed handles outlive their sessions. A later close retries them,
      // while startKillEscalation leaves any current cleanup fiber alone.
      const terminating = [...(yield* readManagerState).terminatingProcesses.entries()].filter(
        ([, { terminal }]) =>
          terminal.threadId === input.threadId &&
          (input.terminalId === undefined || terminal.terminalId === input.terminalId) &&
          !retainedTerminalIds.includes(terminal.terminalId) &&
          !retainedTerminalPrefixes.some((prefix) => terminal.terminalId.startsWith(prefix)),
      );
      yield* Effect.forEach(
        terminating,
        ([process, { terminal }]) =>
          startKillEscalation(process, terminal.threadId, terminal.terminalId),
        { discard: true },
      );

      if (input.terminalId) {
        yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
        return;
      }

      const threadSessions = yield* sessionsForThread(input.threadId);
      yield* Effect.forEach(
        threadSessions.filter(
          (session) =>
            !retainedTerminalIds.includes(session.terminalId) &&
            !retainedTerminalPrefixes.some((prefix) => session.terminalId.startsWith(prefix)),
        ),
        (session) => closeSession(input.threadId, session.terminalId, false),
        { discard: true },
      );

      if (input.deleteHistory) {
        yield* deleteAllHistoryForThread(
          input.threadId,
          retainedTerminalIds,
          retainedTerminalPrefixes,
        );
      }
    });

  const close = (
    input: TerminalCloseInput,
    retainedTerminalIds: ReadonlyArray<string> = [],
    retainedTerminalPrefixes: ReadonlyArray<string> = [],
  ) =>
    withThreadLock(
      input.threadId,
      closeUnlocked(input, retainedTerminalIds, retainedTerminalPrefixes),
    );

  const closeIdle: TerminalManager["Service"]["closeIdle"] = (input) =>
    Effect.gen(function* () {
      const activityMark = (session: TerminalSessionState) =>
        session.eventSequence + session.inputCount;
      const excludedTerminalIds = new Set(input.excludedTerminalIds ?? []);
      const candidates = yield* withThreadLock(
        input.threadId,
        sessionsForThread(input.threadId).pipe(
          Effect.map((sessions) =>
            sessions
              .filter(
                (session): session is TerminalSessionState & { pid: number } =>
                  session.status === "running" &&
                  session.pendingInputCount === 0 &&
                  Number.isInteger(session.pid) &&
                  (input.terminalId === undefined || session.terminalId === input.terminalId) &&
                  !excludedTerminalIds.has(session.terminalId),
              )
              .map((session) => ({
                session,
                process: session.process,
                pid: session.pid,
                spawnedShellName: session.spawnedShellName,
                beforeFirstInput: session.captureShellIdentity !== null,
                activityMark: activityMark(session),
                attachmentGeneration: session.attachmentGeneration,
              })),
          ),
        ),
      );
      if (candidates.length === 0) return;

      // Process inspection can stall. Release the thread lock while it runs,
      // so input and lifecycle operations do not wait for the monitor.
      const { inspector } = yield* acquireSubprocessInspector;
      const inspected = yield* Effect.forEach(candidates, (candidate) =>
        inspector(candidate.pid, candidate.spawnedShellName, candidate.beforeFirstInput).pipe(
          Effect.map((result) => ({
            candidate,
            hasRunningSubprocess: result.hasRunningSubprocess,
          })),
        ),
      );
      yield* withThreadLock(
        input.threadId,
        Effect.forEach(
          inspected,
          ({ candidate, hasRunningSubprocess }) =>
            getSession(input.threadId, candidate.session.terminalId).pipe(
              Effect.flatMap((current) => {
                if (Option.isNone(current)) return Effect.void;
                const session = current.value;
                // Input, output, attachment, or replacement makes the captured
                // idle result obsolete, even when the terminal ID is reused.
                return hasRunningSubprocess ||
                  session !== candidate.session ||
                  session.process !== candidate.process ||
                  session.status !== "running" ||
                  session.pendingInputCount > 0 ||
                  session.attachmentGeneration !== candidate.attachmentGeneration ||
                  activityMark(session) !== candidate.activityMark
                  ? Effect.void
                  : closeSession(input.threadId, session.terminalId, false);
              }),
            ),
          { discard: true },
        ),
      );
    }).pipe(
      // The process check failed, so every terminal stays open.
      Effect.catch((error) =>
        Effect.logWarning("failed to close idle terminals", {
          threadId: input.threadId,
          error: error.message,
        }),
      ),
    );

  const waitForThreadShutdownUnlocked = Effect.fn("terminal.waitForThreadShutdown")(function* (
    threadId: string,
  ): Effect.fn.Return<void, TerminalShutdownError> {
    const state = yield* readManagerState;
    const fibers = [...state.terminatingProcesses.entries()].flatMap(([process, { terminal }]) => {
      const fiber = state.killFibers.get(process);
      return terminal.threadId === threadId && fiber !== undefined ? [fiber] : [];
    });
    yield* Effect.forEach(fibers, Fiber.await, { concurrency: "unbounded", discard: true });
    const remaining = [...(yield* readManagerState).terminatingProcesses.values()]
      .map(({ terminal }) => terminal)
      .filter((terminal) => terminal.threadId === threadId);
    if (remaining.length > 0) {
      return yield* new TerminalShutdownError({
        threadId,
        terminalIds: [...new Set(remaining.map((terminal) => terminal.terminalId))],
      });
    }
  });

  const waitForThreadShutdown: TerminalManager["Service"]["waitForThreadShutdown"] = (threadId) =>
    withThreadLock(threadId, waitForThreadShutdownUnlocked(threadId));

  const shutdownThread: TerminalManager["Service"]["shutdownThread"] = (threadId) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        pendingThreadShutdowns.set(threadId, (pendingThreadShutdowns.get(threadId) ?? 0) + 1);
      }),
      () =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const closeResult = yield* closeUnlocked({ threadId }).pipe(Effect.result);
            const shutdown = yield* waitForThreadShutdownUnlocked(threadId).pipe(Effect.result);
            if (closeResult._tag === "Failure") return yield* closeResult.failure;
            if (shutdown._tag === "Failure") return yield* shutdown.failure;
          }),
        ),
      () =>
        Effect.sync(() => {
          const remaining = (pendingThreadShutdowns.get(threadId) ?? 1) - 1;
          if (remaining === 0) pendingThreadShutdowns.delete(threadId);
          else pendingThreadShutdowns.set(threadId, remaining);
        }),
    );

  const history: TerminalManager["Service"]["history"] = (input) => {
    return flushPersist(input.threadId, input.terminalId).pipe(
      Effect.andThen(readHistory(input.threadId, input.terminalId)),
      Effect.map((persistedHistory) => persistedHistory.value()),
    );
  };
  return TerminalManager.of({
    open,
    attachStream,
    observeStream,
    write,
    resize,
    clear,
    history,
    restart,
    close,
    shutdownThread,
    waitForThreadShutdown,
    closeThreadExcept: (threadId, retainedTerminalIds, retainedTerminalPrefixes) =>
      close({ threadId, deleteHistory: true }, retainedTerminalIds, retainedTerminalPrefixes),
    closeIdle,
    subscribe,
    subscribeMetadata,
    metadata: readAllTerminalMetadata(),
    refreshMetadata: pollSubprocessActivity().pipe(Effect.andThen(readAllTerminalMetadata())),
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
