import type { EnvironmentId, EnvironmentMachineKind, ScopedThreadRef } from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

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
 * Threads to reference from the composer, matched and ranked like the command
 * palette. Eligibility comes from the client's authorized environment catalog,
 * not peer-link membership or sidebar visibility.
 */
export function matchComposerThreadItems(input: {
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
  /** Recency is measured against this time. */
  now: number;
}): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
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
    return isAllowed && !excluded;
  });
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(
      query,
      threadSearchSubject(
        shell,
        shell.projectTitle,
        input.environmentLabels?.get(shell.environmentId),
      ),
      input.now,
      {
        ...options,
        picks: false,
      },
    ),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => {
      const environment =
        shell.environmentId === input.environmentId
          ? undefined
          : input.environmentLabels?.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: [shell.projectTitle, environment].filter(Boolean).join(" · ") || "Thread",
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
 * The user's machines the `@` picker offers, so the agent can link or work there. The
 * composer's own environment is left out. Like threads, they need a query: bare `@` stays a
 * file picker.
 */
export function matchComposerEnvironmentItems(input: {
  environments: ReadonlyArray<ComposerEnvironmentCandidate>;
  environmentId: EnvironmentId;
  query: string;
}): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.environments
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
      description: "Machine",
    }));
}
