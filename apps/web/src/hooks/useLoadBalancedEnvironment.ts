import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { evaluateLoadBalancedEnvironments } from "@t3tools/client-runtime/load-balancing";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useContext, useMemo } from "react";

import { serverEnvironment } from "../state/server";

/** Only mounted for unresolved automatic drafts, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  const registry = useContext(RegistryContext);
  const refresh = useCallback(
    (ids: readonly EnvironmentId[]) => {
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
      }
    },
    [registry],
  );
  const resourcesAtom = useMemo(
    () =>
      Atom.make((get) =>
        environmentIds.map((environmentId) => {
          const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
          return {
            environmentId,
            resources: result._tag === "Success" ? result.value : null,
            ...(result._tag === "Success" ? { receivedAt: result.timestamp } : {}),
            resourcesRequestFailed: result._tag === "Failure",
            pending: result._tag === "Initial" || result.waiting,
            failed: result._tag === "Failure",
          };
        }),
      ),
    [environmentIds],
  );
  const resources = useAtomValue(resourcesAtom);
  const pending = resources.some((resource) => resource.pending);
  const decision = evaluateLoadBalancedEnvironments(
    resources.map((resource) => ({
      ...resource,
      weight: weights[resource.environmentId] ?? 50,
    })),
    Date.now(),
  );
  const environmentId = decision.selectedEnvironmentId as EnvironmentId | null;
  return {
    decision,
    refresh,
    pending,
    environmentId,
    failed: !pending && environmentId === null && resources.some((resource) => resource.failed),
  };
}
