import { describe, expect, it } from "@effect/vitest";
import {
  type AssetCreateUrlResult,
  AssetWorkspaceContextNotFoundError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createAssetEnvironmentAtoms, createProjectFaviconUrlAtomFamily } from "./assets.ts";

describe("project favicon URL cache", () => {
  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("linked thread file ownership", () => {
  it.effect("does not retry linked files against the primary environment", () =>
    Effect.gen(function* () {
      const remoteId = EnvironmentId.make("remote");
      const localId = EnvironmentId.make("local");
      const resource = {
        _tag: "media-file" as const,
        threadId: ThreadId.make("foreign-thread"),
        path: "/tmp/clip.mp4",
        linkedThreadFile: true,
      };
      const error = new AssetWorkspaceContextNotFoundError({ resource });
      const calls: EnvironmentId[] = [];
      const supervisors = new Map<
        EnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor["Service"]
      >();
      for (const environmentId of [remoteId, localId]) {
        const client = {
          [WS_METHODS.assetsCreateUrl]: () => {
            calls.push(environmentId);
            return environmentId === remoteId
              ? Effect.fail(error)
              : Effect.succeed({
                  relativeUrl: `/api/assets/${environmentId}/media`,
                  expiresAt: 999999,
                });
          },
        } as unknown as WsRpcProtocolClient;
        const session = { client } as RpcSession;
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: environmentId,
              httpBaseUrl: `https://${environmentId}.test`,
              wsBaseUrl: `wss://${environmentId}.test`,
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected" as const,
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const environments = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
        followStream: (id, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const localTarget = {
        environmentId: localId,
        httpBaseUrl: "https://local.test",
      };
      const localEnvironment = Atom.make<typeof localTarget | null>(localTarget);
      const assets = createAssetEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
        localEnvironment,
      );
      const query = assets.createUrl({ environmentId: remoteId, input: { resource } });
      const result = AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      expect(yield* Effect.flip(result)).toEqual(error);
      expect(calls).toEqual([remoteId]);
    }).pipe(Effect.scoped),
  );
});
