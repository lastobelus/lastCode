import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEventInput, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { makeWsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPreviewEnvironmentAtoms } from "./preview.ts";

const decodeBrowserEvent = Schema.decodeUnknownSync(DesktopBrowserEventInput);
const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("browser-environment"),
  label: "Browser environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const makeHarness = Effect.fn("PreviewBrowserEventTest.makeHarness")(function* () {
  const received = yield* Deferred.make<Parameters<RpcClient.Protocol["Service"]["run"]>[1]>();
  const sent = yield* Queue.unbounded<Parameters<RpcClient.Protocol["Service"]["send"]>[1]>();
  const protocol = RpcClient.Protocol.of({
    codecFor: RpcSerialization.json.codecFor,
    supportsAck: false,
    supportsTransferables: false,
    run: (_clientId, handle) =>
      Deferred.succeed(received, handle).pipe(Effect.andThen(Effect.never)),
    send: (_clientId, message) => Queue.offer(sent, message).pipe(Effect.asVoid),
  });
  const client = yield* makeWsRpcProtocolClient.pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );
  const handle = yield* Deferred.await(received);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
      Option.some({
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: client.subscribeServerConfig,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      }),
    ),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run,
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const command = createPreviewEnvironmentAtoms(runtime).browserEvent;
  const send = (input: typeof DesktopBrowserEventInput.Type) =>
    command.run(registry, { environmentId: target.environmentId, input });
  return { sent, handle, send };
});

describe("remote browser event delivery", () => {
  it.effect("submits a page's lifecycle burst in order without waiting for replies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const events: Array<(typeof DesktopBrowserEventInput.Type)["event"]> = [
          { type: "attached", threadId: "thread", tabId: "tab", supportsNativeSurface: true },
          ...Array.from({ length: 200 }, (_, index) => ({
            type: "cdp" as const,
            threadId: "thread",
            tabId: "tab",
            message: JSON.stringify({
              method: "Network.requestWillBeSent",
              params: { requestId: String(index) },
            }),
          })),
          {
            type: "cdp",
            threadId: "thread",
            tabId: "tab",
            message: JSON.stringify({ method: "Page.lifecycleEvent", params: { name: "load" } }),
          },
        ];
        const pending = events.map((event) => harness.send({ desktopHostId: "desktop", event }));
        const messages = [];
        for (const event of events) {
          const message = yield* Queue.take(harness.sent);
          expect(message._tag).toBe("Request");
          if (message._tag !== "Request") throw new Error("Expected a browser event request");
          expect(message.tag).toBe(WS_METHODS.desktopBrowserEvent);
          expect(decodeBrowserEvent(message.payload).event).toEqual(event);
          messages.push(message);
        }
        // Replies are deliberately withheld until the load event has reached the wire.
        for (const message of messages)
          yield* harness.handle({
            _tag: "Exit",
            requestId: message.id,
            exit: { _tag: "Success", value: null },
          });
        const results = yield* Effect.promise(() => Promise.all(pending));
        for (const result of results) {
          if (AsyncResult.isFailure(result)) throw new Error(Cause.pretty(result.cause));
          expect(AsyncResult.isSuccess(result)).toBe(true);
        }
      }),
    ),
  );
});
