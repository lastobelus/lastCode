/**
 * Fast per-thread view of the latest durable Action resume lifecycle row.
 *
 * The authoritative history is persisted as `action.resume.lifecycle`
 * activities. This registry is hydrated from those rows at startup and lets
 * shell snapshot queries avoid an activity-table lookup for every thread.
 */
import type { ActionResumeState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const isShellVisible = (state: ActionResumeState): boolean =>
  state.outcome === "running" ||
  state.outcome === "process_lost" ||
  state.delivery === "pending" ||
  state.delivery === "available";

export interface ThreadActionResumeShape {
  readonly record: (state: ActionResumeState) => void;
  readonly clear: (threadId: string) => void;
  readonly getLatest: (threadId: string) => ActionResumeState | null;
  readonly getForShell: (threadId: string) => ActionResumeState | null;
  readonly listLatest: () => ReadonlyArray<ActionResumeState>;
  readonly countRunning: () => number;
}

export function make(): ThreadActionResumeShape {
  const latestByThreadId = new Map<string, ActionResumeState>();

  return {
    record: (state) => {
      latestByThreadId.set(state.threadId, state);
    },
    clear: (threadId) => {
      latestByThreadId.delete(threadId);
    },
    getLatest: (threadId) => latestByThreadId.get(threadId) ?? null,
    getForShell: (threadId) => {
      const state = latestByThreadId.get(threadId);
      return state && isShellVisible(state) ? state : null;
    },
    listLatest: () => [...latestByThreadId.values()],
    countRunning: () =>
      [...latestByThreadId.values()].filter((state) => state.outcome === "running").length,
  };
}

export class ThreadActionResumeService extends Context.Reference<ThreadActionResumeShape>(
  "t3/orchestration/ThreadActionResume/ThreadActionResumeService",
  { defaultValue: make },
) {}

export const layer = Layer.effect(ThreadActionResumeService, Effect.sync(make));
