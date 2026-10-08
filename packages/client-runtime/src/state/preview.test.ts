import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type PreviewHostingLeaseMetadata,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPreviewEnvironmentAtoms } from "./preview.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("preview-environment"),
  label: "Preview environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const LEASE: PreviewHostingLeaseMetadata = {
  leaseId: "preview-lease",
  threadId: ThreadId.make("thread-1"),
  terminalId: "preview-terminal",
  url: "http://localhost:5173/",
  handedOffAt: "2026-10-05T00:00:00.000Z",
  expiresAt: "2026-10-06T00:00:00.000Z",
  status: "active",
};

function config(supported?: boolean): ServerConfig {
  return {
    environment: {
      capabilities: supported === undefined ? {} : { previewHostingProcessControl: supported },
    },
  } as ServerConfig;
}

const makeSession = Effect.fn("PreviewTest.makeSession")(function* (
  supported: boolean | undefined,
  initialLeases: ReadonlyArray<PreviewHostingLeaseMetadata> = [LEASE],
) {
  const leases = yield* Queue.unbounded<ReadonlyArray<PreviewHostingLeaseMetadata>>();
  const stopped = yield* Deferred.make<void>();
  const disconnected = yield* Deferred.make<never, RpcClientError.RpcClientError>();
  let subscriptions = 0;
  let configReads = 0;
  const client = {
    [WS_METHODS.subscribePreviewHosting]: () => {
      subscriptions += 1;
      return Stream.concat(Stream.succeed(initialLeases), Stream.fromQueue(leases)).pipe(
        Stream.merge(Stream.fromEffect(Deferred.await(disconnected)), { haltStrategy: "either" }),
        Stream.ensuring(Deferred.succeed(stopped, undefined)),
      );
    },
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.sync(() => {
      configReads += 1;
      return config(supported);
    }),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return {
    session,
    leases,
    stopped,
    disconnected,
    subscriptions: () => subscriptions,
    configReads: () => configReads,
  };
});

const makeHarness = Effect.fn("PreviewTest.makeHarness")(function* (
  initialSession: Option.Option<RpcSession> = Option.none(),
) {
  const session = yield* SubscriptionRef.make(initialSession);
  const streamStarted = Latch.makeUnsafe();
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) =>
    Stream.suspend(() => {
      streamStarted.openUnsafe();
      return Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
  );
  const atom = createPreviewEnvironmentAtoms(runtime).hostingLeases({
    environmentId: TARGET.environmentId,
    input: {},
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const observed: Array<
    AsyncResult.AsyncResult<ReadonlyArray<PreviewHostingLeaseMetadata>, unknown>
  > = [];
  const unmount = registry.subscribe(atom, (result) => observed.push(result), { immediate: true });
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  return { atom, registry, session, streamStarted, observed };
});

function waitForLeases<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<PreviewHostingLeaseMetadata>, E>>,
  expected: ReadonlyArray<PreviewHostingLeaseMetadata>,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter((result) => AsyncResult.isFailure(result) || AsyncResult.isSuccess(result)),
    Stream.filter(
      (result) =>
        AsyncResult.isFailure(result) ||
        (AsyncResult.isSuccess(result) && result.value === expected),
    ),
    Stream.runHead,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(Option.isSome(result) && AsyncResult.isSuccess(result.value)).toBe(true);
        if (Option.isSome(result) && AsyncResult.isSuccess(result.value)) {
          expect(result.value.value).toEqual(expected);
        }
      }),
    ),
  );
}

describe("preview lease subscriptions", () => {
  it.effect("waits for the first session when mounted before connection startup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* makeSession(true);
        const harness = yield* makeHarness();
        yield* harness.streamStarted.await;
        yield* Effect.yieldNow;

        expect(harness.observed.some(AsyncResult.isFailure)).toBe(false);
        expect(first.configReads()).toBe(0);
        expect(first.subscriptions()).toBe(0);

        const leases = [LEASE];
        yield* Queue.offer(first.leases, leases);
        yield* SubscriptionRef.set(harness.session, Option.some(first.session));
        yield* waitForLeases(harness.registry, harness.atom, leases);
        expect(first.configReads()).toBe(1);
        expect(first.subscriptions()).toBe(1);
        expect(harness.observed.some(AsyncResult.isFailure)).toBe(false);
      }),
    ),
  );

  it.effect("recovers after transport loss and closes subscriptions on session replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstLeases = [LEASE];
        const replacementLeases = [{ ...LEASE, leaseId: "replacement-lease" }];
        const first = yield* makeSession(true, firstLeases);
        const replacement = yield* makeSession(true, replacementLeases);
        const unsupported = yield* makeSession(undefined);
        const harness = yield* makeHarness(Option.some(first.session));
        yield* waitForLeases(harness.registry, harness.atom, firstLeases);

        yield* Deferred.fail(
          first.disconnected,
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "Test transport disconnected",
              cause: new Error("Test transport disconnected"),
            }),
          }),
        );
        yield* Deferred.await(first.stopped);
        yield* SubscriptionRef.set(harness.session, Option.none());
        yield* SubscriptionRef.set(harness.session, Option.some(replacement.session));
        yield* waitForLeases(harness.registry, harness.atom, replacementLeases);

        yield* SubscriptionRef.set(harness.session, Option.some(unsupported.session));
        yield* Deferred.await(replacement.stopped);
        const empty = yield* AtomRegistry.toStream(harness.registry, harness.atom).pipe(
          Stream.filter(
            (result) =>
              AsyncResult.isFailure(result) ||
              (AsyncResult.isSuccess(result) && result.value.length === 0),
          ),
          Stream.runHead,
        );
        expect(Option.isSome(empty) && AsyncResult.isSuccess(empty.value)).toBe(true);
        expect(first.subscriptions()).toBe(1);
        expect(replacement.subscriptions()).toBe(1);
        expect(replacement.configReads()).toBe(1);
        expect(unsupported.configReads()).toBe(1);
        expect(unsupported.subscriptions()).toBe(0);
        expect(harness.observed.some(AsyncResult.isFailure)).toBe(false);
      }),
    ),
  );

  it.effect.each([undefined, false])(
    "emits empty leases without a preview RPC when the server capability is %s",
    (supported) =>
      Effect.scoped(
        Effect.gen(function* () {
          const unsupported = yield* makeSession(supported);
          const harness = yield* makeHarness(Option.some(unsupported.session));
          const result = yield* AtomRegistry.toStream(harness.registry, harness.atom).pipe(
            Stream.filter((result) => !AsyncResult.isInitial(result)),
            Stream.runHead,
          );
          expect(Option.isSome(result) && AsyncResult.isSuccess(result.value)).toBe(true);
          if (Option.isSome(result) && AsyncResult.isSuccess(result.value)) {
            expect(result.value.value).toEqual([]);
          }
          expect(unsupported.configReads()).toBe(1);
          expect(unsupported.subscriptions()).toBe(0);

          const leases = [LEASE];
          const supportedSession = yield* makeSession(true, leases);
          yield* SubscriptionRef.set(harness.session, Option.some(supportedSession.session));
          yield* waitForLeases(harness.registry, harness.atom, leases);
          expect(supportedSession.subscriptions()).toBe(1);
        }),
      ),
  );
});
