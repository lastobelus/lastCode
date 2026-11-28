import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2PendingBackgroundTask, RunId, ThreadId } from "@t3tools/contracts";
import {
  LASTCODE_BACKGROUND_WAIT_ENV,
  LASTCODE_WRAPPED_COMMAND,
  parseLastCodeWrappedAction,
} from "@t3tools/shared/lastcodeWrappedCommands";

// Only accept simple literal commands. Quoted operators are arguments, and shell expansions,
// substitutions, redirects and pipes are outside the wrapper's launch syntax.
function shellSteps(command: string): string[][] | undefined {
  const steps: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (word !== undefined) words.push(word);
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
    } else if (character === ";" || (character === "&" && command[index + 1] === "&")) {
      flush();
      if (words.length === 0) return undefined;
      steps.push(words);
      words = [];
      if (character === "&") index++;
    } else if (
      "|&<>\n\r(){}*?[]".includes(character) ||
      (word === undefined && character === "#")
    ) {
      return undefined;
    } else {
      word = (word ?? "") + character;
    }
  }
  if (quote !== undefined) return undefined;
  flush();
  return words.length === 0 ? undefined : [...steps, words];
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

const wrapperLauncher = "scripts/lc-run";
const shellLaunchers = new Set(["sh", "bash", "zsh"]);
const opaquePrefixCommands = new Set([
  "!",
  ".",
  "alias",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "eval",
  "exec",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "source",
  "then",
  "time",
  "trap",
  "until",
  "while",
  "ash",
  "csh",
  "dash",
  "fish",
  "ksh",
  "tcsh",
]);
const wrapperInspectionCommands = new Set(["ls", "stat", "test", "echo", "printf", "file", "cat"]);

function isSimplePrefix(words: string[]): boolean {
  const invocation = [...words];
  skipEnvironment(invocation);
  const program = basename(invocation[0]);
  if (!program || shellLaunchers.has(program) || opaquePrefixCommands.has(program)) return false;
  // A file inspection can name the launcher without executing it. Otherwise reject prefix steps
  // that name the wrapper, including invocations through an intermediary such as xargs or node.
  return (
    wrapperInspectionCommands.has(program) ||
    !words.some((word) => word.includes(wrapperLauncher) || word.includes(LASTCODE_WRAPPED_COMMAND))
  );
}

export function isLastCodeWrappedCommand(command: string): boolean {
  // Codex may report up to a couple of nested shell invocations.
  for (let depth = 0; depth < 4; depth++) {
    const steps = shellSteps(command.trim());
    if (steps === undefined || !steps.slice(0, -1).every(isSimplePrefix)) return false;
    const words = steps.at(-1)!;
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
    if (shellLaunchers.has(basename(node) ?? "")) {
      if (isScriptPath(script, wrapperLauncher)) {
        return parseLastCodeWrappedAction(args) !== undefined;
      }
      if (args.length !== 1 || !/^-(?:c|lc|cl)$/u.test(script ?? "")) return false;
      command = args[0]!;
      continue;
    }
    if (isScriptPath(node, wrapperLauncher)) {
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
  const markedByTask = new Map<string, { toolUseId: string; originRunId: RunId }>();
  const mark = (
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
        markedByTask.get(task.taskId)?.toolUseId === task.nativeItemId ||
        originRunId == null ||
        !isLastCodeWrappedCommand(task.command)
      )
        continue;
      markedByTask.set(task.taskId, { toolUseId: task.nativeItemId, originRunId });
      marked.push({ taskId: task.taskId, originRunId });
    }
    return marked;
  };
  const owns = (
    taskId: string,
    originRunId: RunId,
    generation: ClaudeWrappedTaskGeneration | undefined,
  ) => {
    const marked = markedByTask.get(taskId);
    return (
      marked?.originRunId === originRunId &&
      generation !== undefined &&
      !generation.retired &&
      (generation.toolUseId === null || generation.toolUseId === marked.toolUseId)
    );
  };
  return {
    mark,
    hasOwedResults: (
      owed: ReadonlyMap<string, RunId> | undefined,
      generations: ReadonlyMap<string, ClaudeWrappedTaskGeneration> | undefined,
    ) => {
      for (const [taskId, originRunId] of owed ?? []) {
        if (owns(taskId, originRunId, generations?.get(taskId))) return true;
      }
      return false;
    },
    retireOwedResults: (
      taskIds: ReadonlySet<string>,
      owed: Map<string, RunId> | undefined,
      generations: ReadonlyMap<string, ClaudeWrappedTaskGeneration> | undefined,
    ) => {
      if (owed === undefined) return;
      for (const taskId of taskIds) {
        const originRunId = owed.get(taskId);
        if (originRunId !== undefined && owns(taskId, originRunId, generations?.get(taskId))) {
          owed.delete(taskId);
        }
      }
    },
  };
}
