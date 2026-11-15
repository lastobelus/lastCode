import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Clock from "effect/Clock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded, type EnvironmentRpcInput } from "../rpc/client.ts";
import type { EnvironmentConnectionSummary } from "./presentation.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

type PauseConnection = EnvironmentConnectionSummary & {
  readonly connected: boolean;
  readonly since: number;
};

export function createEnvironmentPauseConnectionsAtom(
  environmentsAtom: Atom.Atom<readonly EnvironmentConnectionSummary[]>,
) {
  return Atom.make((get) => {
    const previous = Option.getOrNull(get.self<readonly PauseConnection[]>());
    return get(environmentsAtom).map((environment) => {
      const connected = environment.isEnabled && environment.connectionState === "connected";
      const prior = previous?.find(
        (candidate) => candidate.environmentId === environment.environmentId,
      );
      return {
        ...environment,
        connected,
        since:
          prior && prior.connected === connected
            ? prior.since
            : Effect.runSync(Clock.currentTimeMillis),
      };
    });
  });
}

export function createEnvironmentPauseAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const intentState = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<{
      readonly value: "start" | "resume" | null;
      readonly pending: boolean;
      readonly request: number;
    }>({
      value: null,
      pending: false,
      request: 0,
    }).pipe(Atom.keepAlive),
  );
  const intent = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(intentState(environmentId)).value),
  );
  const query = { tag: WS_METHODS.serverEnvironmentPauseStatus, staleTimeMs: 0, idleTtlMs: 0 };
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    ...query,
    label: "environment-data:pause:status",
    onAnswer: ({ environmentId }, answer, registry) =>
      Effect.sync(() => {
        const state = registry.get(intentState(environmentId));
        if (answer.observation === "known" && state.value !== null && !state.pending) {
          registry.set(intentState(environmentId), { ...state, value: null });
        }
      }),
  });
  const monitorFamily = Atom.family((source: ReturnType<typeof status>) =>
    source.pipe(Atom.withRefresh(15_000), Atom.setIdleTTL(0)),
  );
  const monitorStatus = (target: Parameters<typeof status>[0]) => monitorFamily(status(target));
  const changingFamily = Atom.family((source: ReturnType<typeof status>) =>
    source.pipe(Atom.withRefresh(1_000), Atom.setIdleTTL(0)),
  );
  const activeFamily = Atom.family((source: ReturnType<typeof status>) =>
    Atom.transform(
      source,
      (get) => {
        const result = get(source);
        const value = Option.getOrNull(AsyncResult.value(result));
        const changing =
          value?.session != null && (value.session.phase === "resuming" || !value.quiet);
        return get(changing ? changingFamily(source) : monitorFamily(source));
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
  };
  const command = (
    action: "start" | "resume",
    tag: typeof WS_METHODS.serverPauseEnvironment | typeof WS_METHODS.serverResumeEnvironment,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      ...commands,
      label: `environment-data:pause:${action}`,
      tag,
      execute: Effect.fn(`EnvironmentPause.${action}`)(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.serverPauseEnvironment>,
        registry: AtomRegistry.AtomRegistry,
        environmentId: EnvironmentId,
      ) {
        const previous = registry.get(intentState(environmentId));
        const request = previous.request + 1;
        registry.set(intentState(environmentId), { value: action, pending: true, request });
        const result = yield* Effect.exit(requestGuarded(tag, input));
        if (registry.get(intentState(environmentId)).request === request) {
          registry.set(intentState(environmentId), {
            value: Exit.isSuccess(result) ? action : previous.value,
            pending: false,
            request,
          });
        }
        return Exit.isSuccess(result) ? result.value : yield* Effect.failCause(result.cause);
      }),
    });
  return {
    intent,
    status,
    monitorStatus,
    activeStatus,
    start: command("start", WS_METHODS.serverPauseEnvironment),
    retry: createEnvironmentRpcCommand(runtime, {
      ...commands,
      label: "environment-data:pause:retry",
      tag: WS_METHODS.serverRetryEnvironmentPause,
    }),
    resume: command("resume", WS_METHODS.serverResumeEnvironment),
  };
}
