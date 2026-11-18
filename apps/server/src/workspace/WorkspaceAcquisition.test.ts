import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as WorkspaceAcquisition from "./WorkspaceAcquisition.ts";

it.effect("waits for recovery admission before returning an acquired workspace", () =>
  Effect.gen(function* () {
    const gate = yield* WorkspaceAcquisition.WorkspaceAcquisition;
    const waiting = yield* gate
      .acquire({ path: "/managed/old", purpose: "terminal" })
      .pipe(Effect.forkChild);
    yield* gate.install((input) =>
      Effect.succeed({ path: `${input.path}-restored`, branch: "recovery/saved", restored: true }),
    );
    assert.deepStrictEqual(yield* Fiber.join(waiting), {
      path: "/managed/old-restored",
      branch: "recovery/saved",
      restored: true,
    });
  }).pipe(Effect.provide(WorkspaceAcquisition.layer)),
);

it.effect("preserves a discarded-workspace error rather than recreating from a branch", () =>
  Effect.gen(function* () {
    const gate = yield* WorkspaceAcquisition.WorkspaceAcquisition;
    yield* gate.install(() =>
      Effect.fail(new WorkspaceAcquisition.WorkspaceUnavailableError({ reason: "discarded" })),
    );
    const error = yield* gate
      .acquire({ path: "/managed/discarded", purpose: "provider" })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "discarded");
  }).pipe(Effect.provide(WorkspaceAcquisition.layer)),
);

it.effect("does not replace the application recovery handler on duplicate installation", () =>
  Effect.gen(function* () {
    const gate = yield* WorkspaceAcquisition.WorkspaceAcquisition;
    yield* gate.install((input) =>
      Effect.succeed({ path: input.path, branch: "saved", restored: false }),
    );
    yield* gate.install(() =>
      Effect.succeed({ path: "/unrelated", branch: "wrong", restored: false }),
    );
    assert.strictEqual(
      (yield* gate.acquire({ path: "/managed/original", purpose: "git" })).path,
      "/managed/original",
    );
  }).pipe(Effect.provide(WorkspaceAcquisition.layer)),
);
