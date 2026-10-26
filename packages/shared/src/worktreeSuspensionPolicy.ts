import type { WorktreeSuspensionPolicy, WorktreeSuspensionScopes } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const DAY_MS = 24 * 60 * 60 * 1000;

export type WorktreeSuspensionScope = keyof WorktreeSuspensionScopes;

export interface WorktreeSuspensionCandidate {
  readonly kind: "subagent" | "thread";
  readonly agentCreatedChild: boolean | null;
  readonly humanParticipation: boolean | null;
  readonly settledAt: string | null;
  readonly lastWorkspaceUseAt: string | null;
  readonly active: boolean;
  readonly pendingWork: boolean;
  readonly held: boolean;
}

export type WorktreeSuspensionKeptReason =
  | "policy-off"
  | "invalid-policy"
  | "workspace-held"
  | "active"
  | "pending-work"
  | "not-settled"
  | "unknown-scope"
  | "scope-disabled"
  | "invalid-time"
  | "waiting";

export type WorktreeSuspensionEligibility =
  | {
      readonly eligible: true;
      readonly scope: WorktreeSuspensionScope;
      readonly ageAnchorAt: string;
    }
  | { readonly eligible: false; readonly reason: WorktreeSuspensionKeptReason };

function timestamp(value: string): number | null {
  const date = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T/.exec(value);
  if (date === null || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // Date.parse can normalize a nonexistent calendar date into the next month.
  const calendar = DateTime.make(`${date[0].slice(0, -1)}T00:00:00.000Z`);
  if (Option.isNone(calendar)) return null;
  const parts = DateTime.toPartsUtc(calendar.value);
  return parts.month === Number(date[2]) && parts.day === Number(date[3]) ? parsed : null;
}

function candidateScope(candidate: WorktreeSuspensionCandidate): WorktreeSuspensionScope | null {
  if (candidate.humanParticipation === true) return "otherThreads";
  if (candidate.kind === "subagent") return "subagents";
  if (candidate.agentCreatedChild === false) {
    return "otherThreads";
  }
  return candidate.agentCreatedChild === true && candidate.humanParticipation === false
    ? "untouchedChildren"
    : null;
}

/** Evaluates one owner's automatic admission; checkout-wide guards belong to the caller. */
export function evaluateWorktreeSuspensionEligibility(input: {
  readonly policy: WorktreeSuspensionPolicy;
  readonly candidate: WorktreeSuspensionCandidate;
  readonly now: number;
}): WorktreeSuspensionEligibility {
  const { policy, candidate, now } = input;
  if (candidate.held) return { eligible: false, reason: "workspace-held" };
  if (candidate.active) return { eligible: false, reason: "active" };
  if (candidate.pendingWork) return { eligible: false, reason: "pending-work" };
  if (policy.mode === "off") return { eligible: false, reason: "policy-off" };
  if (!Number.isInteger(policy.afterDays) || policy.afterDays < 1 || policy.afterDays > 3650) {
    return { eligible: false, reason: "invalid-policy" };
  }
  if (candidate.settledAt === null) return { eligible: false, reason: "not-settled" };
  const scope = candidateScope(candidate);
  if (scope === null) return { eligible: false, reason: "unknown-scope" };
  if (!policy.scopes[scope]) return { eligible: false, reason: "scope-disabled" };
  const settled = timestamp(candidate.settledAt);
  const lastUse =
    candidate.lastWorkspaceUseAt === null ? null : timestamp(candidate.lastWorkspaceUseAt);
  if (
    !Number.isFinite(now) ||
    settled === null ||
    (candidate.lastWorkspaceUseAt !== null && lastUse === null)
  ) {
    return { eligible: false, reason: "invalid-time" };
  }
  const ageAnchor = Math.max(settled, lastUse ?? settled);
  if (now - ageAnchor < policy.afterDays * DAY_MS) return { eligible: false, reason: "waiting" };
  return {
    eligible: true,
    scope,
    ageAnchorAt:
      lastUse !== null && lastUse > settled
        ? (candidate.lastWorkspaceUseAt ?? candidate.settledAt)
        : candidate.settledAt,
  };
}
