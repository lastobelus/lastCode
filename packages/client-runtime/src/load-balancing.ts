import type { HostResourcesSnapshot } from "@t3tools/contracts";

/** Callers supply only connected machines hosting the project and selected provider. */
export function evaluateLoadBalancedEnvironments(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
) {
  let selectedEnvironmentId: string | null = null;
  let bestScore = 0;
  const evaluations = candidates.map(({ environmentId, resources, receivedAt, weight }) => {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    const reason = (() => {
      if (!resources) return "missing-resources" as const;
      if (!Number.isFinite(weight) || weight < 0) return "invalid-weight" as const;
      if (weight === 0) return "manual-only" as const;
      if (now - sampledAt > 15_000 || sampledAt > now + 5_000) {
        return "stale-resources" as const;
      }
      if (resources.cpuUtilization === null) return "cpu-unavailable" as const;
      if (resources.cpuUtilization >= 0.95) return "cpu-saturated" as const;
      if (resources.totalMemoryBytes <= 0 || resources.cpuCount <= 0) {
        return "invalid-capacity" as const;
      }
      if (resources.availableMemoryBytes / resources.totalMemoryBytes <= 0.05) {
        return "memory-pressure" as const;
      }
      return null;
    })();
    const score =
      reason === null && resources && resources.cpuUtilization !== null
        ? weight *
          resources.cpuCount *
          (1 - resources.cpuUtilization) *
          (resources.availableMemoryBytes / resources.totalMemoryBytes)
        : null;
    if (score !== null && score > bestScore) {
      selectedEnvironmentId = environmentId;
      bestScore = score;
    }
    return {
      environmentId,
      weight,
      receivedAt: receivedAt ?? null,
      sampleAgeMs: resources || receivedAt !== undefined ? now - sampledAt : null,
      resources,
      score,
      reason,
    };
  });
  return { selectedEnvironmentId, candidates: evaluations };
}
