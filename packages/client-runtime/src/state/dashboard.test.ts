import { EnvironmentId, ProjectId, ThreadId, type ThreadDashboardItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProjectDashboard } from "./dashboard.ts";
import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-a");
const at = "2026-06-20T00:00:00.000Z";
function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return { ...presentThreadShell(environmentId, v2ThreadShell), ...overrides };
}
function item(id: string, overrides: Partial<ThreadDashboardItem> = {}): ThreadDashboardItem {
  return {
    id,
    title: id,
    body: "Details",
    kind: "question",
    status: "open",
    priority: "normal",
    effort: "unspecified",
    requiresComputer: false,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("project dashboard", () => {
  it("expires snoozes and respects a pending request that wakes one early", () => {
    const snoozed = thread({ snoozedUntil: "2026-06-20T01:00:00.000Z", snoozedAt: at });
    expect(buildProjectDashboard([snoozed], undefined, at).parked).toHaveLength(1);
    expect(
      buildProjectDashboard([snoozed], undefined, "2026-06-20T02:00:00.000Z").parked,
    ).toHaveLength(0);
    expect(
      buildProjectDashboard([{ ...snoozed, hasPendingApprovals: true }], undefined, at).parked,
    ).toHaveLength(0);
  });
  it("keeps questions and QA independent, with overlapping effort and computer counts", () => {
    const input = thread({
      dashboardItems: [
        item("choose", { effort: "quick" }),
        item("verify", { kind: "qa", effort: "quick", requiresComputer: true }),
        item("plan", { kind: "review", effort: "focused" }),
        item("metric", { kind: "metric", effort: "quick" }),
        item("done", { status: "resolved" }),
      ],
    });
    const board = buildProjectDashboard([input]);
    expect(board.counts).toEqual({
      total: 1,
      active: 0,
      waiting: 0,
      needsAttention: 3,
      quick: 2,
      focused: 1,
      computer: 1,
    });
    expect(board.entries).toHaveLength(4);
    expect(input.dashboardItems?.[1]?.status).toBe("open");
    const answered = thread({
      dashboardItems: (input.dashboardItems ?? []).map((entry) =>
        entry.id === "choose" ? { ...entry, status: "resolved" } : entry,
      ),
    });
    expect(
      buildProjectDashboard([answered])
        .entries.filter((entry) => entry.actionable)
        .map((entry) => entry.title),
    ).toEqual(["plan", "verify"]);
  });

  it("scopes project identity by environment and does not count duplicate shells", () => {
    const selected = thread({ dashboardItems: [item("same-id")] });
    const otherEnvironment = thread({
      environmentId: EnvironmentId.make("environment-b"),
      dashboardItems: [item("same-id")],
    });
    const otherProject = thread({ projectId: ProjectId.make("other-project") });
    const scope = { environmentId, projectId: selected.projectId };
    expect(
      buildProjectDashboard([selected, selected, otherEnvironment, otherProject], scope).counts
        .total,
    ).toBe(1);
    const both = buildProjectDashboard([selected, otherEnvironment]);
    expect(new Set(both.entries.map((entry) => entry.id)).size).toBe(2);
  });

  it("preserves parked requests while excluding deleted, archived and child conversations", () => {
    const parked = thread({ settledAt: at, dashboardItems: [item("qa", { kind: "qa" })] });
    const child = thread({
      id: ThreadId.make("child"),
      lineage: {
        rootThreadId: parked.id,
        parentThreadId: parked.id,
        relationshipToParent: "subagent",
      },
    });
    const board = buildProjectDashboard([
      parked,
      child,
      thread({ archivedAt: at }),
      thread({ deletedAt: at }),
    ]);
    expect(board.counts.total).toBe(1);
    expect(board.entries[0]?.title).toBe("qa");
    expect(board.parked).toEqual([parked]);
  });

  it("sorts actionable urgency before age and leaves passive metrics below requests", () => {
    const board = buildProjectDashboard([
      thread({
        dashboardItems: [
          item("metric", { kind: "metric", priority: "high" }),
          item("new", { createdAt: "2026-06-22T00:00:00.000Z" }),
          item("old", { createdAt: "2026-06-19T00:00:00.000Z" }),
          item("urgent", { priority: "high", createdAt: "2026-06-23T00:00:00.000Z" }),
        ],
      }),
    ]);
    expect(board.entries.map((entry) => entry.title)).toEqual(["urgent", "old", "new", "metric"]);
  });

  it("includes independent native requests without treating machine waits as human requests", () => {
    const waiting = thread({
      id: ThreadId.make("waiting"),
      runtime: {
        status: "waiting",
        activeRunId: null,
        providerInstanceId: v2ThreadShell.providerInstanceId,
        providerName: null,
        lastError: null,
        updatedAt: at,
      },
    });
    const requests = thread({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      attention: { kind: "question", raisedAt: at },
      hasActionableProposedPlan: true,
    });
    const board = buildProjectDashboard([waiting, requests]);
    expect(board.counts.waiting).toBe(1);
    expect(board.counts.needsAttention).toBe(4);
    expect(board.entries.map((entry) => entry.kind).sort()).toEqual([
      "approval",
      "input",
      "question",
      "review",
    ]);
  });
});
