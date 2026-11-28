import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../../updates/updateMachine.ts";
import { checkForUpdate } from "./updates.ts";

it.effect("requires an explicit true IPC option to request a checkpoint", () => {
  const state = createInitialDesktopUpdateState(
    "1.2.3",
    {
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
    },
    "nightly",
  );
  const check = vi.fn((reason: string) =>
    Effect.succeed({
      checked: true,
      checkpointRequested: reason === "checkpoint-request",
      error: null,
      state,
    }),
  );

  return Effect.gen(function* () {
    expect(yield* checkForUpdate.handler(undefined)).toMatchObject({ checkpointRequested: false });
    expect(yield* checkForUpdate.handler({ requestCheckpoint: false })).toMatchObject({
      checkpointRequested: false,
    });
    expect(yield* checkForUpdate.handler({ requestCheckpoint: true })).toMatchObject({
      checkpointRequested: true,
    });
    const invalid = yield* Effect.exit(checkForUpdate.handler({ requestCheckpoint: "true" }));
    expect(invalid._tag).toBe("Failure");
    expect(check.mock.calls).toEqual([["web-ui"], ["web-ui"], ["checkpoint-request"]]);
  }).pipe(Effect.provide(Layer.mock(DesktopUpdates.DesktopUpdates, { check })));
});
