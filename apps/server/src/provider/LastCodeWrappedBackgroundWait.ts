import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2PendingBackgroundTask, RunId, ThreadId } from "@t3tools/contracts";
import {
  LASTCODE_BACKGROUND_WAIT_ENV,
  LASTCODE_WRAPPED_COMMAND,
  parseLastCodeWrappedAction,
} from "@t3tools/shared/lastcodeWrappedCommands";

type ShellToken = string | { readonly operator: "&&" };

const shellAnd = { operator: "&&" } as const;

// Only accept simple literal commands. Quoted operators are arguments, and shell expansions,
// substitutions, redirects, pipes and extra commands are outside the wrapper's launch syntax.
function shellTokens(command: string): ShellToken[] | undefined {
  const tokens: ShellToken[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (word !== undefined) tokens.push(word);
    word = undefined;
  };
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === quote) {
      quote = undefined;
    } else if (character === "\\" && quote !== "'") {
      const escaped = command[++index];
      if (escaped === undefined) return undefined;
      if (escaped === "\n") continue;
      word = (word ?? "") + (quote === '"' && !'\\$"`'.includes(escaped) ? "\\" : "") + escaped;
    } else if (quote === "'") {
      word = (word ?? "") + character;
    } else if (character === "$" || character === "`") {
      return undefined;
    } else if (quote === '"') {
      word = (word ?? "") + character;
    } else if (character === "'" || character === '"') {
      quote = character;
      word ??= "";
    } else if (character === " " || character === "\t") {
      flush();
    } else if (character === "&" && command[index + 1] === "&") {
      flush();
      tokens.push(shellAnd);
      index++;
    } else if (
      ";|&<>\n\r(){}*?[]".includes(character) ||
      (word === undefined && character === "#")
    ) {
      return undefined;
    } else {
      word = (word ?? "") + character;
    }
  }
  if (quote !== undefined) return undefined;
  flush();
  return tokens;
}

const basename = (command: string | undefined) => command?.split("/").at(-1);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const isScriptPath = (value: string | undefined, path: string) =>
  value === path || value?.endsWith(`/${path}`) === true;

function skipEnvironment(words: string[]): void {
  if (basename(words[0]) === "env") {
    words.shift();
    if (words[0] === "--") words.shift();
  }
  while (words[0] !== undefined && assignment.test(words[0])) words.shift();
}

export function isLastCodeWrappedCommand(command: string): boolean {
  // Codex may report up to a couple of nested shell invocations.
  for (let depth = 0; depth < 4; depth++) {
    const tokens = shellTokens(command.trim());
    if (tokens === undefined) return false;
    const parts = tokens.indexOf(shellAnd);
    const words = (parts === -1 ? tokens : tokens.slice(parts + 1)).flatMap((token) =>
      typeof token === "string" ? [token] : [],
    );
    if (parts !== -1) {
      const prefix = tokens.slice(0, parts);
      if (
        !(prefix[0] === "cd" && (parts === 2 || (parts === 3 && prefix[1] === "--"))) ||
        tokens.lastIndexOf(shellAnd) !== parts
      )
        return false;
    }
    skipEnvironment(words);
    if (basename(words[0]) === "mise") {
      if (
        words[1] !== "exec" ||
        !/^node@\d+(?:\.\d+){0,2}$/u.test(words[2] ?? "") ||
        words[3] !== "--"
      ) {
        return false;
      }
      words.splice(0, 4);
    } else if (["pnpm", "npm", "vp", "yarn", "bun"].includes(basename(words[0]) ?? "")) {
      if (words[1] !== "exec") return false;
      words.splice(0, words[2] === "--" ? 3 : 2);
    }
    const [node, script, ...args] = words;
    if (["sh", "bash", "zsh"].includes(basename(node) ?? "")) {
      if (isScriptPath(script, "scripts/lc-run")) {
        return parseLastCodeWrappedAction(args) !== undefined;
      }
      if (args.length !== 1 || !/^-(?:c|lc|cl)$/u.test(script ?? "")) return false;
      command = args[0]!;
      continue;
    }
    if (isScriptPath(node, "scripts/lc-run")) {
      return parseLastCodeWrappedAction(words.slice(1)) !== undefined;
    }
    return (
      basename(node) === "node" &&
      isScriptPath(script, LASTCODE_WRAPPED_COMMAND) &&
      parseLastCodeWrappedAction(args) !== undefined
    );
  }
  return false;
}

export function shouldAwaitLastCodeWrappedCommand(enabled: boolean, command: string): boolean {
  return enabled && isLastCodeWrappedCommand(command);
}

export function lastCodeWrappedCommandEnvironment(enabled: boolean): Record<string, string> {
  return enabled ? { [LASTCODE_BACKGROUND_WAIT_ENV]: "1" } : {};
}

export function withLastCodeClaudeBackgroundLimit(
  settings: ClaudeSdkSettings | undefined,
  enabled: boolean,
  configuredTimeout: string | undefined,
): ClaudeSdkSettings | undefined {
  if (!enabled) return settings;
  return {
    ...settings,
    env: {
      ...settings?.env,
      ...lastCodeWrappedCommandEnvironment(true),
      // Claude uses its foreground default as the background default when it exceeds 30 minutes.
      ...(configuredTimeout === undefined ? { BASH_DEFAULT_TIMEOUT_MS: "7200000" } : {}),
    },
  };
}

export type ClaudeWrappedTaskGeneration = {
  readonly toolUseId: string | null;
  readonly ambiguous: boolean;
  readonly retired: boolean;
};

export function makeLastCodeClaudeWrappedTaskMarker(enabled: boolean, threadId: ThreadId) {
  const lastMarkedToolUseByTask = new Map<string, string>();
  return (
    roster: ReadonlyMap<string, OrchestrationV2PendingBackgroundTask>,
    generations: ReadonlyMap<string, ClaudeWrappedTaskGeneration> | undefined,
    origins: ReadonlyMap<string, RunId | null> | undefined,
  ): ReadonlyArray<{ readonly taskId: string; readonly originRunId: RunId }> => {
    if (!enabled) return [];
    const marked: Array<{ taskId: string; originRunId: RunId }> = [];
    for (const task of roster.values()) {
      if (
        task.kind !== "command" ||
        task.parentTaskId !== undefined ||
        task.sourceThreadId !== threadId ||
        task.command == null
      )
        continue;
      const generation = generations?.get(task.taskId);
      const originRunId = origins?.get(task.taskId);
      if (
        generation === undefined ||
        task.nativeItemId === undefined ||
        (generation.toolUseId !== null && generation.toolUseId !== task.nativeItemId) ||
        generation.ambiguous ||
        generation.retired ||
        lastMarkedToolUseByTask.get(task.taskId) === task.nativeItemId ||
        originRunId == null ||
        !isLastCodeWrappedCommand(task.command)
      )
        continue;
      lastMarkedToolUseByTask.set(task.taskId, task.nativeItemId);
      marked.push({ taskId: task.taskId, originRunId });
    }
    return marked;
  };
}
