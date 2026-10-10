import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLoadBalancingDecisionLog,
  loadBalancingExclusionReason,
  type LoadBalancingDecisionRecord,
} from "./loadBalancingDiagnostics";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const eligibility = {
  connectionPhase: "connected",
  weight: 50,
  providers: [provider],
  providerInstanceId: "codex",
  providerDriver: "codex",
};

describe("loadBalancingExclusionReason", () => {
  it("accepts a usable instance and explains disconnected or manual-only hosts", () => {
    expect(loadBalancingExclusionReason(eligibility)).toBeNull();
    expect(loadBalancingExclusionReason({ ...eligibility, connectionPhase: "disconnected" })).toBe(
      "disconnected",
    );
    expect(loadBalancingExclusionReason({ ...eligibility, weight: 0 })).toBe("manual-only");
  });

  it("requires the selected instance and driver rather than another usable instance", () => {
    expect(loadBalancingExclusionReason({ ...eligibility, providerInstanceId: "other" })).toBe(
      "provider-missing",
    );
    expect(loadBalancingExclusionReason({ ...eligibility, providerDriver: "claude" })).toBe(
      "provider-missing",
    );
    expect(loadBalancingExclusionReason({ ...eligibility, providerInstanceId: null })).toBeNull();
  });

  it.each([
    [{ enabled: false }, "provider-disabled"],
    [{ installed: false }, "provider-not-installed"],
    [{ status: "error" }, "provider-error"],
    [{ auth: { status: "unauthenticated" } }, "provider-unauthenticated"],
    [{ availability: "unavailable" }, "provider-unavailable"],
  ] as const)("explains unusable provider state %j", (override, reason) => {
    expect(
      loadBalancingExclusionReason({ ...eligibility, providers: [{ ...provider, ...override }] }),
    ).toBe(reason);
  });
});

const decision: LoadBalancingDecisionRecord = {
  draftId: "draft-1",
  threadId: "thread-1",
  providerInstanceId: "codex",
  providerDriver: "codex",
  selectedEnvironmentId: "workstation.example",
  candidates: [
    {
      environmentId: "workstation.example",
      label: "workstation.example",
      weight: 100,
      receivedAt: 1_000,
      sampleAgeMs: 0,
      resources: {
        sampledAt: 1_000,
        cpuCount: 8,
        cpuUtilization: 0.5,
        totalMemoryBytes: 1_000,
        availableMemoryBytes: 500,
      },
      score: 200,
      reason: null,
    },
    {
      environmentId: "managed-server",
      label: "managed-server",
      weight: 50,
      receivedAt: null,
      sampleAgeMs: null,
      resources: null,
      score: null,
      reason: "provider-missing",
    },
  ],
};

function storage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

describe("Auto balance decision logging", () => {
  it("writes nothing while disabled and stops exactly at the 24-hour deadline", () => {
    const disk = storage();
    const log = createLoadBalancingDecisionLog(disk);
    log.record(decision, 1_000);
    expect(disk.entries.size).toBe(0);
    log.start(1_000);
    const deadline = 1_000 + 24 * 60 * 60 * 1_000;
    log.record(decision, deadline - 1);
    log.record(decision, deadline);
    expect(log.getSnapshot().records).toHaveLength(1);
  });

  it("restores logging after a restart and exports scores, samples, and exclusions", () => {
    const disk = storage();
    const log = createLoadBalancingDecisionLog(disk);
    log.start(1_000);
    log.record(decision, 1_000);
    const restored = createLoadBalancingDecisionLog(disk);
    restored.record({ ...decision, draftId: "draft-2" }, 2_000);
    const exported = JSON.parse(restored.export());
    expect(exported.decisions).toHaveLength(2);
    expect(exported.decisions[0]).toEqual({
      ...decision,
      decidedAt: new Date(1_000).toISOString(),
    });
    restored.stop();
    restored.record(decision, 3_000);
    expect(restored.getSnapshot().records).toHaveLength(2);
  });

  it("retains only the latest 200 decisions across restarts", () => {
    const disk = storage();
    const log = createLoadBalancingDecisionLog(disk);
    log.start(1_000);
    for (let index = 0; index < 205; index++) {
      log.record({ ...decision, draftId: `draft-${index}` }, 1_000 + index);
    }
    const exported = JSON.parse(createLoadBalancingDecisionLog(disk).export());
    expect(exported.decisions).toHaveLength(200);
    expect(exported.decisions[0].draftId).toBe("draft-5");
    expect(exported.decisions[199].draftId).toBe("draft-204");
  });

  it("does not fill the log when re-renders only age the same resource samples", () => {
    const log = createLoadBalancingDecisionLog(storage());
    log.start(1_000);
    log.record(decision, 1_000);
    log.record(
      {
        ...decision,
        candidates: decision.candidates.map((candidate) => ({ ...candidate, sampleAgeMs: 500 })),
      },
      1_500,
    );
    expect(log.getSnapshot().records).toHaveLength(1);
    log.record({ ...decision, selectedEnvironmentId: null }, 2_000);
    expect(log.getSnapshot().records).toHaveLength(2);
  });

  it("does not report a saved decision when storage fails", () => {
    const disk = storage();
    const log = createLoadBalancingDecisionLog(disk);
    log.start(1_000);
    disk.setItem = () => {
      throw new Error("Storage full");
    };
    expect(() => log.record(decision, 2_000)).toThrow("Storage full");
    expect(log.getSnapshot().records).toHaveLength(0);
  });
});
