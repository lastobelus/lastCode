import type { ProjectAutoPullStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export type AutoPullOutcome =
  | { readonly result: "pulled" | "up-to-date" }
  | { readonly result: "skipped" | "failed"; readonly reason: string };

export interface AutoPullCheckoutState {
  readonly isRepo: boolean;
  readonly isDefaultBranch: boolean;
  readonly branch: string | null;
  readonly hasUpstream: boolean;
  readonly hasWorkingTreeChanges: boolean;
  readonly aheadCount: number;
}

/** Why automatic pull must leave this checkout alone, or null when a fast-forward is safe. */
export function autoPullSkipReason(state: AutoPullCheckoutState): string | null {
  if (!state.isRepo) return "not a Git repository";
  if (!state.isDefaultBranch)
    return state.branch === null
      ? "detached HEAD, not the default branch"
      : `on branch ${state.branch}, not the default branch`;
  if (!state.hasUpstream) return "no upstream branch";
  if (state.hasWorkingTreeChanges) return "uncommitted changes";
  if (state.aheadCount > 0)
    return `${state.aheadCount} local ${state.aheadCount === 1 ? "commit" : "commits"}`;
  return null;
}

export function autoPullFailureReason(error: { readonly message: string }): string {
  const firstLine = error.message.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "unknown error";
  return firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine;
}

export const make = () => {
  const byWorkspaceRoot = new Map<string, ProjectAutoPullStatus>();
  return {
    record: Effect.fn("AutoPullStatus.record")(function* (
      workspaceRoot: string,
      outcome: AutoPullOutcome,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const succeeded = outcome.result === "pulled" || outcome.result === "up-to-date";
      byWorkspaceRoot.set(workspaceRoot, {
        lastAttemptAt: now,
        lastSuccessAt: succeeded
          ? now
          : (byWorkspaceRoot.get(workspaceRoot)?.lastSuccessAt ?? null),
        result: outcome.result,
        reason: "reason" in outcome ? outcome.reason : null,
      });
    }),
    get: (workspaceRoot: string) => Effect.sync(() => byWorkspaceRoot.get(workspaceRoot) ?? null),
  };
};

// Process-wide on purpose: startup, status refreshes, and project reads share one record,
// and it resets with the server because each start runs a fresh attempt.
export class AutoPullStatus extends Context.Reference<ReturnType<typeof make>>(
  "t3/project/AutoPullStatus",
  { defaultValue: make },
) {}
