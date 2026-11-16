import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import { makeHostingClientActivity } from "./HostingClientActivity.ts";
import * as Hosting from "./Hosting.ts";

it.effect(
  "client activity acknowledgement waits for protection and disconnect releases only its owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const active = new Map<
          string,
          Parameters<Hosting.PreviewHosting["Service"]["setActivity"]>[0]
        >();
        const entered = yield* Deferred.make<void>();
        const acknowledge = yield* Deferred.make<void>();
        const hosting = yield* Hosting.PreviewHosting.pipe(
          Effect.provide(
            Layer.mock(Hosting.PreviewHosting)({
              setActivity: (input) =>
                Effect.gen(function* () {
                  if (input.active) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(acknowledge);
                    active.set(input.activityId, input);
                  } else active.delete(input.activityId);
                }),
              list: () => Effect.succeed([]),
            }),
          ),
        );
        const connectionA = yield* Scope.make();
        const connectionB = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(connectionA, Exit.void));
        yield* Effect.addFinalizer(() => Scope.close(connectionB, Exit.void));
        const ownerA = yield* makeHostingClientActivity(hosting, "connection-a").pipe(
          Effect.provideService(Scope.Scope, connectionA),
        );
        const ownerB = yield* makeHostingClientActivity(hosting, "connection-b").pipe(
          Effect.provideService(Scope.Scope, connectionB),
        );
        const input = {
          activityId: "same-client-id",
          threadId: ThreadId.make("thread-1"),
          url: "http://localhost:5173/",
          active: true,
        };
        const pending = yield* ownerA(input).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        expect(active.size).toBe(0);
        yield* Deferred.succeed(acknowledge, undefined);
        yield* Fiber.join(pending);
        yield* ownerB(input);
        expect(active.size).toBe(2);
        yield* Scope.close(connectionA, Exit.void);
        expect([...active.keys()]).toEqual(["client:connection-b:same-client-id"]);
        yield* Scope.close(connectionB, Exit.void);
        expect(active.size).toBe(0);
      }),
    ),
);

it.effect("a private client alias protects only the thread's unique owned listener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const declarations: Array<Parameters<Hosting.PreviewHosting["Service"]["setActivity"]>[0]> =
        [];
      const lease: Hosting.PreviewHostingLease = {
        id: "lease",
        threadId: ThreadId.make("thread-1"),
        terminalId: "terminal",
        command: "fixture",
        cwd: "/tmp/fixture-project",
        worktreePath: null,
        url: "http://localhost:5173/",
        handedOffAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
        status: "active",
      };
      const hosting = yield* Hosting.PreviewHosting.pipe(
        Effect.provide(
          Layer.mock(Hosting.PreviewHosting)({
            setActivity: (input) =>
              Effect.sync(() => {
                declarations.push(input);
              }),
            list: (threadId) => Effect.succeed(threadId === lease.threadId ? [lease] : []),
          }),
        ),
      );
      const setActivity = yield* makeHostingClientActivity(hosting, "connection");
      yield* setActivity({
        activityId: "native",
        threadId: ThreadId.make("thread-1"),
        url: "http://10.0.0.10:5173/form#preview",
        active: true,
      });
      expect(declarations.at(-1)?.url).toBe("http://localhost:5173/form#preview");
      yield* setActivity({
        activityId: "other",
        threadId: ThreadId.make("other-thread"),
        url: "http://10.0.0.10:5173/form#preview",
        active: true,
      });
      expect(declarations.at(-1)?.url).toBe("http://10.0.0.10:5173/form#preview");
    }),
  ),
);
