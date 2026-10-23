import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { prepareHostedPreview, type PreparedHostedPreview } from "../previewHosting.ts";
import type { RpcSession } from "../rpc/session.ts";
import { executeAtomQuery, squashAtomCommandFailure } from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("bootstrap-environment"),
  label: "Bootstrap environment",
  httpBaseUrl: "https://environment.example/",
  wsBaseUrl: "wss://environment.example/",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: null,
  target,
};

const makeHarness = Effect.fn("SessionTest.makeHarness")(function* () {
  const config = yield* Deferred.make<ServerConfig, ConnectionTransientError>();
  const configRead = yield* Deferred.make<void>();
  const session: RpcSession = {
    client: {} as RpcSession["client"],
    initialConfig: Deferred.succeed(configRead, undefined).pipe(
      Effect.andThen(Deferred.await(config)),
    ),
    subscribeServerConfig: () => {
      throw new Error("Unexpected config subscription.");
    },
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _id,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const atoms = createEnvironmentSessionAtoms(runtime);
  const renew = vi.fn(async (_url: string, _refresh: boolean) => "/api/assets/renewed/report.html");
  const opened = vi.fn<(value: PreparedHostedPreview) => void>();
  const list = vi.fn(async () => []);
  const url = "https://environment.example/api/assets/expired/report.html";
  const start = () =>
    prepareHostedPreview({
      threadRef: { environmentId: target.environmentId, threadId: ThreadId.make("thread-1") },
      url,
      environmentUrl: target.httpBaseUrl,
      list,
      recover: async () => null,
      renewDocumentUrl: async (url, refresh) => {
        const result = await executeAtomQuery(
          registry,
          atoms.bootstrap({
            environmentId: target.environmentId,
            input: undefined,
          }),
          { reportFailure: false, refresh: true },
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        expect(result.value.prepared).toEqual(prepared);
        if (result.value.config.environment.capabilities.previewAssetRecovery !== true) return null;
        return renew(url, refresh);
      },
    }).then(opened);
  return {
    config,
    configRead,
    session,
    supervisor,
    atoms,
    registry,
    renew,
    opened,
    list,
    url,
    start,
  };
});

const completeStartup = Effect.fn("SessionTest.completeStartup")(function* (supported: boolean) {
  const harness = yield* makeHarness();
  const pending = yield* Effect.promise(harness.start).pipe(Effect.forkChild);
  yield* Deferred.await(harness.configRead);
  expect(harness.opened).not.toHaveBeenCalled();
  expect(harness.renew).not.toHaveBeenCalled();
  yield* Deferred.succeed(harness.config, {
    environment: { capabilities: supported ? { previewAssetRecovery: true } : {} },
  } as ServerConfig);
  yield* Fiber.join(pending);
  expect(harness.opened).toHaveBeenCalledExactlyOnceWith(
    supported
      ? {
          url: "https://environment.example/api/assets/renewed/report.html",
          managed: false,
          restored: true,
          restarted: true,
        }
      : { url: harness.url, managed: false, restored: false },
  );
  expect(harness.renew).toHaveBeenCalledTimes(supported ? 1 : 0);
  expect(harness.list).not.toHaveBeenCalled();
});

describe("environment bootstrap", () => {
  it.effect("keeps the first open pending until config is ready, then renews once", () =>
    Effect.scoped(completeStartup(true)),
  );
  it.effect("keeps the first open pending for an old host, then preserves the original", () =>
    Effect.scoped(completeStartup(false)),
  );
  it.effect("fails preparation when readiness fails without emitting the expired link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const pending = yield* Effect.tryPromise(harness.start).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(harness.configRead);
        yield* Deferred.fail(
          harness.config,
          new ConnectionTransientError({
            reason: "transport",
            detail: "Initial configuration unavailable.",
          }),
        );
        const error = yield* Fiber.join(pending);
        expect(error.cause).toMatchObject({ name: "HostedPreviewRecoveryError" });
        expect(harness.opened).not.toHaveBeenCalled();
        expect(harness.renew).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect(
    "continues preparation on a replacement session instead of waiting for stale config",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const pending = yield* Effect.promise(harness.start).pipe(Effect.forkChild);
          yield* Deferred.await(harness.configRead);
          yield* SubscriptionRef.set(
            harness.supervisor.session,
            Option.some({
              ...harness.session,
              initialConfig: Effect.succeed({
                environment: { capabilities: { previewAssetRecovery: true } },
              } as ServerConfig),
            }),
          );
          yield* Fiber.join(pending);
          expect(harness.opened).toHaveBeenCalledOnce();
          expect(harness.renew).toHaveBeenCalledExactlyOnceWith(harness.url, true);
        }),
      ),
  );
});
