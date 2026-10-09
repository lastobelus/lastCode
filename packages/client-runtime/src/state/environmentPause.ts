import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createEnvironmentPauseAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const query = { tag: WS_METHODS.serverEnvironmentPauseStatus, staleTimeMs: 0, idleTtlMs: 0 };
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    ...query,
    label: "environment-data:pause:status",
  });
  const monitorFamily = Atom.family((source: ReturnType<typeof status>) =>
    source.pipe(Atom.withRefresh(15_000), Atom.setIdleTTL(0)),
  );
  const monitorStatus = (target: Parameters<typeof status>[0]) => monitorFamily(status(target));
  const activeFamily = Atom.family((source: ReturnType<typeof status>) =>
    Atom.transform(
      source,
      (get) => {
        const result = get(source);
        const value = Option.getOrNull(AsyncResult.value(result));
        const changing =
          value?.session != null && (value.session.phase === "resuming" || !value.quiet);
        const timer = setTimeout(() => get.refresh(source), changing ? 1_000 : 15_000);
        get.addFinalizer(() => clearTimeout(timer));
        return result;
      },
      { initialValueTarget: source },
    ).pipe(Atom.setIdleTTL(0)),
  );
  const activeStatus = (target: Parameters<typeof status>[0]) => activeFamily(status(target));
  const commands = {
    onSettled: (
      { environmentId }: { environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) =>
      Effect.sync(() => {
        registry.refresh(status({ environmentId, input: {} }));
      }),
    scheduler,
    concurrency: {
      mode: "serial" as const,
      key: ({ environmentId }: { environmentId: string }) => environmentId,
    },
  };
  return {
    // All readers share the same query. Monitor slowly; count down only in an open dialog.
    status,
    monitorStatus,
    activeStatus,
    start: createEnvironmentRpcCommand(runtime, {
      ...commands,
      label: "environment-data:pause:start",
      tag: WS_METHODS.serverPauseEnvironment,
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      ...commands,
      label: "environment-data:pause:retry",
      tag: WS_METHODS.serverRetryEnvironmentPause,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      ...commands,
      label: "environment-data:pause:resume",
      tag: WS_METHODS.serverResumeEnvironment,
    }),
  };
}
