import type { WorktreeSuspensionPolicy } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  evaluateWorktreeSuspensionEligibility,
  type WorktreeSuspensionCandidate,
} from "./worktreeSuspensionPolicy.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLED_AT = "2026-10-01T00:00:00.000Z";
const SETTLED_MS = Date.parse(SETTLED_AT);
const candidate: WorktreeSuspensionCandidate = {
  kind: "thread",
  agentCreatedChild: true,
  humanParticipation: false,
  settledAt: SETTLED_AT,
  lastWorkspaceUseAt: null,
  active: false,
  pendingWork: false,
  held: false,
};
const policy: WorktreeSuspensionPolicy = {
  mode: "custom",
  afterDays: 3,
  scopes: { subagents: true, untouchedChildren: true, otherThreads: true },
};

function evaluate(
  input: {
    readonly candidate?: Partial<WorktreeSuspensionCandidate>;
    readonly policy?: WorktreeSuspensionPolicy;
    readonly now?: number;
  } = {},
) {
  return evaluateWorktreeSuspensionEligibility({
    policy: input.policy ?? policy,
    candidate: { ...candidate, ...input.candidate },
    now: input.now ?? SETTLED_MS + 30 * DAY_MS,
  });
}

describe("evaluateWorktreeSuspensionEligibility", () => {
  it("keeps work when the policy is Off or no scope was enabled", () => {
    expect(evaluate({ policy: { mode: "off" } })).toEqual({
      eligible: false,
      reason: "policy-off",
    });
    expect(
      evaluate({
        policy: {
          ...policy,
          scopes: { subagents: false, untouchedChildren: false, otherThreads: false },
        },
      }),
    ).toEqual({ eligible: false, reason: "scope-disabled" });
  });

  it.each([3, 14])("uses the configured %s-day interval at its exact boundary", (afterDays) => {
    const configured = { ...policy, afterDays };
    expect(evaluate({ policy: configured, now: SETTLED_MS + afterDays * DAY_MS - 1 })).toEqual({
      eligible: false,
      reason: "waiting",
    });
    expect(evaluate({ policy: configured, now: SETTLED_MS + afterDays * DAY_MS })).toEqual({
      eligible: true,
      scope: "untouchedChildren",
      ageAnchorAt: SETTLED_AT,
    });
  });

  it.each([
    [{ kind: "subagent" as const, agentCreatedChild: null, humanParticipation: null }, "subagents"],
    [{ agentCreatedChild: true, humanParticipation: false }, "untouchedChildren"],
    [{ agentCreatedChild: false, humanParticipation: null }, "otherThreads"],
    [{ agentCreatedChild: true, humanParticipation: true }, "otherThreads"],
  ] as const)("requires the enabled scope for %j", (flags, scope) => {
    const scopes = { subagents: false, untouchedChildren: false, otherThreads: false };
    expect(evaluate({ candidate: flags, policy: { ...policy, scopes } })).toEqual({
      eligible: false,
      reason: "scope-disabled",
    });
    expect(
      evaluate({ candidate: flags, policy: { ...policy, scopes: { ...scopes, [scope]: true } } }),
    ).toEqual({ eligible: true, scope, ageAnchorAt: SETTLED_AT });
  });

  it.each([
    { agentCreatedChild: true, humanParticipation: null },
    { agentCreatedChild: null, humanParticipation: false },
    { agentCreatedChild: null, humanParticipation: null },
  ])("keeps incomplete child participation or lineage evidence: %j", (flags) => {
    expect(evaluate({ candidate: flags })).toEqual({ eligible: false, reason: "unknown-scope" });
  });

  it("uses known user adoption even when child lineage is incomplete", () => {
    expect(
      evaluate({ candidate: { agentCreatedChild: null, humanParticipation: true } }),
    ).toMatchObject({ eligible: true, scope: "otherThreads" });
  });

  it("requires the user-owned scope after a user participates in a subagent", () => {
    const adopted = { kind: "subagent" as const, humanParticipation: true };
    expect(
      evaluate({
        candidate: adopted,
        policy: { ...policy, scopes: { ...policy.scopes, otherThreads: false } },
      }),
    ).toEqual({ eligible: false, reason: "scope-disabled" });
    expect(evaluate({ candidate: adopted })).toMatchObject({
      eligible: true,
      scope: "otherThreads",
    });
  });

  it.each([
    [{ held: true }, "workspace-held"],
    [{ active: true }, "active"],
    [{ pendingWork: true }, "pending-work"],
    [{ settledAt: null }, "not-settled"],
  ] as const)("keeps work with %j despite its elapsed interval", (flags, reason) => {
    expect(evaluate({ candidate: flags })).toEqual({ eligible: false, reason });
  });

  it("gives holds and activity precedence over settlement and delay", () => {
    expect(
      evaluate({ candidate: { held: true, active: true, pendingWork: true, settledAt: null } }),
    ).toEqual({ eligible: false, reason: "workspace-held" });
    expect(evaluate({ candidate: { active: true, pendingWork: true, settledAt: null } })).toEqual({
      eligible: false,
      reason: "active",
    });
  });

  it("restarts the interval after a restore or actual workspace use", () => {
    const restoredAt = "2026-10-20T00:00:00.000Z";
    const restored = Date.parse(restoredAt);
    expect(
      evaluate({ candidate: { lastWorkspaceUseAt: restoredAt }, now: restored + 2 * DAY_MS }),
    ).toEqual({ eligible: false, reason: "waiting" });
    expect(
      evaluate({ candidate: { lastWorkspaceUseAt: restoredAt }, now: restored + 3 * DAY_MS }),
    ).toEqual({ eligible: true, scope: "untouchedChildren", ageAnchorAt: restoredAt });
  });

  it("keeps the later settlement anchor when workspace use was earlier", () => {
    expect(
      evaluate({
        candidate: { lastWorkspaceUseAt: "2026-09-01T00:00:00.000Z" },
        now: SETTLED_MS + 2 * DAY_MS,
      }),
    ).toEqual({ eligible: false, reason: "waiting" });
    expect(
      evaluate({ candidate: { lastWorkspaceUseAt: "2026-09-01T00:00:00.000Z" } }),
    ).toMatchObject({ eligible: true, ageAnchorAt: SETTLED_AT });
  });

  it("ignores unrelated metadata and a separate parent's activity", () => {
    const withMetadata = {
      ...candidate,
      updatedAt: "2026-10-30T00:00:00.000Z",
      pullRequestRefreshedAt: "2026-10-30T00:00:00.000Z",
      parentActive: true,
    };
    expect(
      evaluateWorktreeSuspensionEligibility({
        policy,
        candidate: withMetadata,
        now: SETTLED_MS + 3 * DAY_MS,
      }),
    ).toEqual({ eligible: true, scope: "untouchedChildren", ageAnchorAt: SETTLED_AT });
  });

  it.each(["invalid", "2026-02-30T00:00:00.000Z", "2026-10-01", "2026-10-01T00:00:00"])(
    "keeps an invalid or unzoned age anchor: %s",
    (value) => {
      expect(evaluate({ candidate: { settledAt: value } })).toEqual({
        eligible: false,
        reason: "invalid-time",
      });
      expect(evaluate({ candidate: { lastWorkspaceUseAt: value } })).toEqual({
        eligible: false,
        reason: "invalid-time",
      });
    },
  );

  it("does not admit a future settlement or invalid clock", () => {
    expect(evaluate({ now: SETTLED_MS - 1 })).toEqual({ eligible: false, reason: "waiting" });
    expect(evaluate({ now: Number.NaN })).toEqual({ eligible: false, reason: "invalid-time" });
    expect(evaluate({ now: Number.POSITIVE_INFINITY })).toEqual({
      eligible: false,
      reason: "invalid-time",
    });
  });

  it.each([0, -1, 1.5, 3651, Number.NaN])(
    "keeps an invalid normalized policy delay: %s",
    (afterDays) => {
      expect(evaluate({ policy: { ...policy, afterDays } })).toEqual({
        eligible: false,
        reason: "invalid-policy",
      });
    },
  );
});
