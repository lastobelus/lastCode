import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  EnvironmentPauseError,
  WS_METHODS,
  type AuthSessionState,
  type EnvironmentPauseStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createEnvironmentPauseAtoms,
  createEnvironmentPauseConnectionsAtom,
} from "./environmentPause.ts";
import type { EnvironmentConnectionSummary } from "./presentation.ts";
import { executeAtomQuery } from "./runtime.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../rpc/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc/client.ts")>()),
  request: mocks.request,
  requestGuarded: mocks.request,
}));
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);

const unpaused: EnvironmentPauseStatus = {
  session: null,
  observation: "known",
  quiet: true,
  activeThreadCount: 0,
  blockers: [],
};

const makeHarness = Effect.fn("TestEnvironmentPause.makeHarness")(function* () {
  mocks.request.mockReset();
  const environmentId = EnvironmentId.make("workstation");
  const state = yield* SubscriptionRef.make({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected" as const,
  });
  const supervisor = {
    target: { environmentId },
    state,
    session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
  } as unknown as EnvironmentSupervisor["Service"];
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run,
      followStream,
      stateChanges: () => SubscriptionRef.changes(state),
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(
    sessions(environmentId),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationOperateScope],
    }),
  );
  return { environmentId, registry, pause: createEnvironmentPauseAtoms(runtime) };
});

it.effect(
  "publishes each Pause or Resume intent before its reply and preserves newer clicks and failure recovery",
  () =>
    Effect.gen(function* () {
      const { environmentId, registry, pause } = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const nextEntered = yield* Deferred.make<void>();
      const nextRelease = yield* Deferred.make<void>();
      const resumeEntered = yield* Deferred.make<void>();
      const resumeRelease = yield* Deferred.make<void>();
      let pauseRequests = 0;
      let resumeRequests = 0;
      let resumeFails = false;
      const calls: Array<readonly [EnvironmentId, string]> = [];
      let observedStatus = unpaused;
      mocks.request.mockImplementation((tag: string) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            calls.push([supervisor.target.environmentId, tag]);
            if (tag === WS_METHODS.serverPauseEnvironment) {
              pauseRequests++;
              return Deferred.succeed(pauseRequests === 1 ? entered : nextEntered, undefined).pipe(
                Effect.andThen(Deferred.await(pauseRequests === 1 ? release : nextRelease)),
                Effect.as(unpaused),
              );
            }
            if (tag === WS_METHODS.serverResumeEnvironment) {
              resumeRequests++;
              if (resumeRequests === 1)
                return Deferred.succeed(resumeEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(resumeRelease)),
                  Effect.as(unpaused),
                );
              if (resumeFails)
                return Effect.fail(
                  new EnvironmentPauseError({ operation: "resume", reason: "unavailable" }),
                );
            }
            return Effect.succeed(observedStatus);
          }),
        ),
      );
      const target = { environmentId, input: {} };
      const pendingPause = pause.start.run(registry, target);
      yield* Deferred.await(entered);
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      expect(registry.get(pause.intent(EnvironmentId.make("other")))).toBe(null);
      const pendingResume = pause.resume.run(registry, target);
      yield* Deferred.await(resumeEntered);
      expect(registry.get(pause.intent(environmentId))).toBe("resume");
      expect(yield* Deferred.isDone(release)).toBe(false);
      expect(calls).toEqual([
        [environmentId, WS_METHODS.serverPauseEnvironment],
        [environmentId, WS_METHODS.serverResumeEnvironment],
      ]);
      yield* Effect.promise(() => executeAtomQuery(registry, pause.status(target)));
      expect(registry.get(pause.intent(environmentId))).toBe("resume");
      const nextPause = pause.start.run(registry, target);
      yield* Deferred.await(nextEntered);
      expect(pauseRequests).toBe(2);
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      yield* Deferred.succeed(resumeRelease, undefined);
      yield* Effect.promise(() => pendingResume);
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => pendingPause);
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      yield* Effect.promise(() =>
        executeAtomQuery(registry, pause.status(target), { refresh: true }),
      );
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      resumeFails = true;
      const failed = yield* Effect.promise(() => pause.resume.run(registry, target));
      expect(AsyncResult.isFailure(failed)).toBe(true);
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      resumeFails = false;
      yield* Effect.promise(() => pause.resume.run(registry, target));
      expect(registry.get(pause.intent(environmentId))).toBe("resume");
      yield* Deferred.succeed(nextRelease, undefined);
      yield* Effect.promise(() => nextPause);
      expect(registry.get(pause.intent(environmentId))).toBe("resume");
      observedStatus = { ...unpaused, observation: "unknown" };
      yield* Effect.promise(() =>
        executeAtomQuery(registry, pause.status(target), { refresh: true }),
      );
      expect(registry.get(pause.intent(environmentId))).toBe("resume");
      yield* Effect.promise(() => pause.start.run(registry, target));
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      yield* Effect.promise(() =>
        executeAtomQuery(registry, pause.status(target), { refresh: true }),
      );
      expect(registry.get(pause.intent(environmentId))).toBe("start");
      observedStatus = unpaused;
      yield* Effect.promise(() =>
        executeAtomQuery(registry, pause.status(target), { refresh: true }),
      );
      expect(registry.get(pause.intent(environmentId))).toBe(null);
    }),
);

it.effect("does not dispatch or switch to Resume without the destination's permission", () =>
  Effect.gen(function* () {
    const { environmentId, registry, pause } = yield* makeHarness();
    const granted = AsyncResult.getOrElse(registry.get(sessions(environmentId)), () => null)!;
    registry.set(
      sessions(environmentId),
      AsyncResult.success({ ...granted, scopes: [], permissions: [] }),
    );
    for (const command of [pause.start, pause.resume, pause.retry]) {
      const outcome = yield* Effect.promise(() =>
        command.run(registry, { environmentId, input: {} }),
      );
      expect(AsyncResult.isFailure(outcome)).toBe(true);
    }
    expect(mocks.request).not.toHaveBeenCalled();
    expect(registry.get(pause.intent(environmentId))).toBe(null);
  }),
);

it("requires a fresh pause observation after reconnect, preserving other environments", () => {
  const environment: EnvironmentConnectionSummary = {
    environmentId: EnvironmentId.make("first"),
    environmentLabel: "First",
    displayUrl: "https://workstation.example",
    isRelayManaged: false,
    isEnabled: true,
    connectionState: "connected",
    connectionError: null,
    connectionErrorTraceId: null,
  };
  const other = { ...environment, environmentId: EnvironmentId.make("second") };
  const environments = Atom.make<readonly EnvironmentConnectionSummary[]>([environment, other]);
  const connections = createEnvironmentPauseConnectionsAtom(environments);
  const registry = AtomRegistry.make();
  using now = vi.spyOn(Date, "now").mockReturnValue(100);
  const stop = registry.subscribe(connections, () => {});
  try {
    expect(registry.get(connections).map((entry) => entry.since)).toEqual([100, 100]);
    now.mockReturnValue(200);
    registry.set(environments, [{ ...environment, connectionState: "offline" }, other]);
    expect(registry.get(connections).map((entry) => [entry.connected, entry.since])).toEqual([
      [false, 200],
      [true, 100],
    ]);
    now.mockReturnValue(300);
    registry.set(environments, [environment, other]);
    expect(registry.get(connections).map((entry) => entry.since)).toEqual([300, 100]);
    now.mockReturnValue(400);
    registry.set(environments, [{ ...environment, environmentLabel: "Renamed" }, other]);
    expect(registry.get(connections).map((entry) => entry.since)).toEqual([300, 100]);
  } finally {
    stop();
    registry.dispose();
  }
});
