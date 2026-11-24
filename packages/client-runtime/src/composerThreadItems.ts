import type { EnvironmentId, EnvironmentMachineKind, ScopedThreadRef } from "@t3tools/contracts";
import { rankThreadMentions } from "@t3tools/shared/lastcodeThreadMentionSearch";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage"> & {
    readonly projectId?: string;
    readonly projectTitle?: string;
  };

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, including archived and subagent threads on
 * authorized environments. Side chats are only offered from their parent thread.
 */
export function matchComposerThreadItems(
  input: {
    shells: ReadonlyArray<ComposerThreadCandidate>;
    environmentId: EnvironmentId;
    /** All connected, read-authorized environments, including the current one. */
    allowedEnvironmentIds: ReadonlySet<EnvironmentId>;
    /** Names for disambiguating results across environments. */
    environmentLabels?: ReadonlyMap<EnvironmentId, string>;
    /** Current scoped thread, if any. */
    excludeThread: ScopedThreadRef | null;
    /** Lightweight server candidates for archived/subagent/omitted shells. */
    candidates?: ReadonlyArray<ComposerThreadCandidate>;
    query: string;
    now: number;
  },
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  // Closing an unused side chat deletes it, so only used side chats of the current thread qualify.
  const isOwnUsedSideChat = (shell: ComposerThreadCandidate) =>
    shell.lineage.sideChat === true &&
    shell.environmentId === input.excludeThread?.environmentId &&
    shell.lineage.parentThreadId === input.excludeThread?.threadId &&
    shell.latestUserMessageAt !== null &&
    shell.archivedAt === null;
  const byKey = new Map<string, ComposerThreadCandidate>();
  for (const shell of [...input.shells, ...(input.candidates ?? [])]) {
    byKey.set(JSON.stringify([shell.environmentId, shell.id]), shell);
  }
  const candidates = [...byKey.values()].filter((shell) => {
    const isAllowed = input.allowedEnvironmentIds.has(shell.environmentId);
    const excluded = input.excludeThread
      ? input.excludeThread.environmentId === shell.environmentId &&
        input.excludeThread.threadId === shell.id
      : false;
    return isAllowed && !excluded && (shell.lineage.sideChat !== true || isOwnUsedSideChat(shell));
  });
  return rankThreadMentions(input.query, candidates, (shell) =>
    threadSearchSubject(
      shell,
      shell.projectTitle,
      input.environmentLabels?.get(shell.environmentId),
    ),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => {
      const environment =
        shell.environmentId === input.environmentId
          ? undefined
          : input.environmentLabels?.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: isOwnUsedSideChat(shell)
          ? resolve(msg("Side chat"))
          : [shell.projectTitle, environment].filter(Boolean).join(" · ") ||
            resolve(msg("Thread", { $context: "noun, search result type" })),
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The machines the `@` picker offers, so the agent can link or work there: the client's paired
 * machines and those the composer's environment links to. The composer's own environment is
 * left out. Like threads, they need a query: bare `@` stays a file picker.
 */
export function matchComposerEnvironmentItems(
  input: {
    environments: ReadonlyArray<ComposerEnvironmentCandidate>;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    environmentId: EnvironmentId;
    query: string;
  },
  resolve: MFunctionType = mFallback,
): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const paired = new Set(input.environments.map((environment) => environment.environmentId));
  const linkedOnly = Array.from(input.linkedEnvironments, ([environmentId, label]) => ({
    environmentId,
    label,
    machine: "server" as const,
  })).filter((environment) => !paired.has(environment.environmentId));
  return [...input.environments, ...linkedOnly]
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: resolve(msg("Machine", { $context: "noun, search result type" })),
    }));
}
