import type { ServerProvider } from "@t3tools/contracts";
import type { evaluateLoadBalancedEnvironments } from "@t3tools/client-runtime/load-balancing";

const STORAGE_KEY = "t3:auto-balance-decisions";
const LOG_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_DECISIONS = 200;

export function loadBalancingExclusionReason(input: {
  connectionPhase: string | undefined;
  weight: number;
  providers: readonly ServerProvider[] | undefined;
  providerInstanceId: string | null;
  providerDriver: string;
}) {
  if (input.connectionPhase !== "connected") return "disconnected" as const;
  if (input.weight <= 0) return "manual-only" as const;
  const matching = input.providers?.filter(
    (provider) =>
      (input.providerInstanceId === null || provider.instanceId === input.providerInstanceId) &&
      provider.driver === input.providerDriver,
  );
  if (!matching?.length) return "provider-missing" as const;
  if (
    matching.some(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status !== "error" &&
        provider.auth.status !== "unauthenticated" &&
        provider.availability !== "unavailable",
    )
  )
    return null;
  const provider = matching[0]!;
  if (!provider.enabled) return "provider-disabled" as const;
  if (!provider.installed) return "provider-not-installed" as const;
  if (provider.status === "error") return "provider-error" as const;
  if (provider.auth.status === "unauthenticated") return "provider-unauthenticated" as const;
  return "provider-unavailable" as const;
}

type Evaluation = ReturnType<typeof evaluateLoadBalancedEnvironments>["candidates"][number];

export interface LoadBalancingDecisionRecord {
  draftId: string;
  threadId: string | null;
  providerInstanceId: string | null;
  providerDriver: string;
  selectedEnvironmentId: string | null;
  candidates: readonly (Omit<Evaluation, "reason"> & {
    label: string;
    reason: Evaluation["reason"] | ReturnType<typeof loadBalancingExclusionReason>;
  })[];
}

interface LogState {
  expiresAt: number;
  records: readonly string[];
}

/** Local, bounded diagnostics survive restarts without recording prompts or credentials. */
export function createLoadBalancingDecisionLog(storage: Pick<Storage, "getItem" | "setItem">) {
  let state: LogState | undefined;
  let lastDecision: string | undefined;
  const listeners = new Set<() => void>();
  const refresh = (): LogState => {
    let next: LogState = { expiresAt: 0, records: [] };
    try {
      const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      if (
        saved &&
        typeof saved === "object" &&
        "expiresAt" in saved &&
        typeof saved.expiresAt === "number" &&
        "records" in saved &&
        Array.isArray(saved.records) &&
        saved.records.every((entry) => typeof entry === "string")
      ) {
        next = { expiresAt: saved.expiresAt, records: saved.records.slice(-MAX_DECISIONS) };
      }
    } catch {
      // A transient read failure must not discard an already loaded log.
      next = state ?? next;
    }
    if (
      state &&
      state.expiresAt === next.expiresAt &&
      state.records.length === next.records.length &&
      state.records.every((record, index) => record === next.records[index])
    ) {
      return state;
    }
    if (state?.expiresAt !== next.expiresAt) lastDecision = undefined;
    state = next;
    for (const listener of listeners) listener();
    return state;
  };
  const getSnapshot = (): LogState => state ?? refresh();
  const save = (next: LogState) => {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot,
    refresh,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: (now = Date.now()) => {
      save({ ...refresh(), expiresAt: now + LOG_DURATION_MS });
      lastDecision = undefined;
    },
    stop: () => save({ ...refresh(), expiresAt: 0 }),
    record: (decision: LoadBalancingDecisionRecord, now = Date.now()) => {
      const current = refresh();
      if (now >= current.expiresAt) return;
      // Re-renders can age the same sample without making another routing decision.
      const signature = JSON.stringify({
        ...decision,
        candidates: decision.candidates.map(({ sampleAgeMs: _age, ...candidate }) => candidate),
      });
      if (signature === lastDecision) return;
      save({
        ...current,
        records: [
          ...current.records,
          JSON.stringify({ ...decision, decidedAt: new Date(now).toISOString() }),
        ].slice(-MAX_DECISIONS),
      });
      lastDecision = signature;
    },
    export: () => {
      const current = refresh();
      return `{"expiresAt":${current.expiresAt},"decisions":[${current.records.join(",")}]}\n`;
    },
  };
}

export const loadBalancingDecisionLog = createLoadBalancingDecisionLog({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) loadBalancingDecisionLog.refresh();
  });
}
