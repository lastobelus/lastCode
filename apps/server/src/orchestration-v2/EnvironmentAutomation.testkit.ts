import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as EnvironmentPauseStore from "../environment/EnvironmentPauseStore.ts";

export const makePausedEnvironment = Effect.gen(function* () {
  const session: EnvironmentPauseStore.StoredSession = {
    id: "pause-session-fixture",
    phase: "pausing",
    createdAt: "2026-10-01T00:00:00.000Z",
    targets: [],
  };
  const state = yield* Ref.make<EnvironmentPauseStore.StoredSession | null>(session);
  return {
    state,
    pause: Ref.set(state, session),
    resume: Ref.set(state, { ...session, phase: "resuming" as const }),
    layer: Layer.succeed(EnvironmentPauseStore.EnvironmentPauseStore, {
      get: Ref.get(state),
      update: (f) => Ref.updateAndGet(state, f),
      recordDelivery: () => Effect.void,
    }),
  };
});
