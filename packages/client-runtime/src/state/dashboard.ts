import type { ScopedProjectRef, ThreadDashboardItem } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { threadKey } from "./entities.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

export interface DashboardEntry {
  readonly id: string;
  readonly thread: EnvironmentThreadShell;
  readonly item: ThreadDashboardItem | null;
  readonly title: string;
  readonly body: string;
  readonly kind: ThreadDashboardItem["kind"] | "approval" | "input" | "failure";
  readonly priority: ThreadDashboardItem["priority"];
  readonly effort: ThreadDashboardItem["effort"];
  readonly requiresComputer: boolean;
  readonly raisedAt: string;
  readonly updatedAt: string;
  readonly actionable: boolean;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A project board reads bounded shells, never every conversation's transcript.
 * Reported requests remain independent of inferred runtime state and settlement. */
export function buildProjectDashboard(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  scope?: ScopedProjectRef,
  // @effect-diagnostics-next-line globalDate:off -- Client wall clock drives snooze expiry.
  now = new Date().toISOString(),
) {
  const entries: DashboardEntry[] = [];
  const parked: EnvironmentThreadShell[] = [];
  const counts = {
    total: 0,
    active: 0,
    waiting: 0,
    needsAttention: 0,
    quick: 0,
    focused: 0,
    computer: 0,
  };
  const seen = new Set<string>();
  for (const thread of threads) {
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      (thread.lineage.relationshipToParent === "subagent" && thread.lineage.independent !== true) ||
      (scope !== undefined &&
        (thread.projectId !== scope.projectId || thread.environmentId !== scope.environmentId))
    )
      continue;
    const key = threadKey({ environmentId: thread.environmentId, threadId: thread.id });
    if (seen.has(key)) continue;
    seen.add(key);
    counts.total++;
    const status = thread.runtime?.status;
    const active =
      status === "preparing" ||
      status === "queued" ||
      status === "starting" ||
      status === "running";
    if (active) counts.active++;
    else if (status === "waiting" || thread.pendingBackgroundTasks.length > 0) counts.waiting++;
    if (thread.settledAt !== null || effectiveSnoozed(thread, { now })) parked.push(thread);

    for (const item of thread.dashboardItems ?? []) {
      if (item.status !== "open") continue;
      entries.push({
        id: `${key}:item:${item.id}`,
        thread,
        item,
        title: item.title,
        body: item.body,
        kind: item.kind,
        priority: item.priority,
        effort: item.effort,
        requiresComputer: item.requiresComputer,
        raisedAt: item.createdAt,
        updatedAt: item.updatedAt,
        actionable: item.kind === "question" || item.kind === "review" || item.kind === "qa",
      });
    }

    const addSignal = (
      kind: DashboardEntry["kind"],
      title: string,
      body: string,
      options: Partial<Pick<DashboardEntry, "priority" | "effort" | "raisedAt">> = {},
    ) =>
      entries.push({
        id: `${key}:signal:${kind}`,
        thread,
        item: null,
        title,
        body,
        kind,
        priority: "normal",
        effort: "unspecified",
        requiresComputer: false,
        raisedAt: thread.updatedAt,
        updatedAt: thread.updatedAt,
        actionable: true,
        ...options,
      });
    if (thread.hasPendingApprovals) {
      addSignal(
        "approval",
        "Approval needed",
        "Open the thread to inspect and answer the approval request.",
        { priority: "high" },
      );
    }
    if (thread.hasPendingUserInput) {
      addSignal("input", "Input requested", "Open the thread to answer its pending input request.");
    }
    if (thread.attention != null) {
      addSignal(
        "question",
        "Question waiting",
        "The agent has marked this thread as waiting for your answer.",
        { raisedAt: thread.attention.raisedAt },
      );
    }
    if (thread.hasActionableProposedPlan && !active && status !== "waiting") {
      addSignal(
        "review",
        "Plan ready to review",
        "Open the thread to read the plan and decide what happens next.",
        { effort: "focused" },
      );
    }
    if (
      thread.runtime?.status === "failed" ||
      (thread.latestRun?.status === "failed" && !active && status !== "waiting")
    ) {
      addSignal(
        "failure",
        "Thread needs a check",
        thread.runtime?.lastError ?? "The latest run failed. Open the thread for details.",
        { priority: "high" },
      );
    }
  }
  entries.sort(
    (a, b) =>
      Number(b.actionable) - Number(a.actionable) ||
      Number(b.priority === "high") - Number(a.priority === "high") ||
      timestamp(a.raisedAt) - timestamp(b.raisedAt) ||
      a.id.localeCompare(b.id),
  );
  for (const entry of entries) {
    if (!entry.actionable) continue;
    counts.needsAttention++;
    if (entry.effort === "quick") counts.quick++;
    if (entry.effort === "focused") counts.focused++;
    if (entry.requiresComputer) counts.computer++;
  }
  return { entries, counts, parked };
}
