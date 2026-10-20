import { ThreadId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { awaitThreadShell } from "./threadShellAvailability.ts";

describe("repair thread shell availability", () => {
  it.effect("waits for the launched thread, ignoring unrelated shell updates", () => {
    const registry = AtomRegistry.make();
    const snapshot = Atom.make<OrchestrationV2ShellSnapshot | null>(null);
    let ready = false;
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        awaitThreadShell(registry, snapshot, v2ThreadShell.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              ready = true;
            }),
          ),
        ),
        { startImmediately: true },
      );
      expect(ready).toBe(false);
      registry.set(snapshot, {
        ...v2ShellSnapshot,
        threads: [{ ...v2ThreadShell, id: ThreadId.make("unrelated") }],
      });
      expect(ready).toBe(false);
      registry.set(snapshot, { ...v2ShellSnapshot, threads: [v2ThreadShell] });
      yield* Fiber.join(fiber);
      expect(ready).toBe(true);
    }).pipe(Effect.ensuring(Effect.sync(() => registry.dispose())));
  });

  it.effect("accepts a shell that arrived before the launch receipt", () => {
    const registry = AtomRegistry.make();
    const snapshot = Atom.make<OrchestrationV2ShellSnapshot | null>({
      ...v2ShellSnapshot,
      threads: [v2ThreadShell],
    });
    return awaitThreadShell(registry, snapshot, v2ThreadShell.id).pipe(
      Effect.ensuring(Effect.sync(() => registry.dispose())),
    );
  });

  it.effect("reports that creation succeeded when synchronization times out", () => {
    const registry = AtomRegistry.make();
    const snapshot = Atom.make<OrchestrationV2ShellSnapshot | null>(null);
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        awaitThreadShell(registry, snapshot, v2ThreadShell.id).pipe(Effect.flip),
        { startImmediately: true },
      );
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toContain("repair thread was created");
    }).pipe(Effect.ensuring(Effect.sync(() => registry.dispose())));
  });
});
