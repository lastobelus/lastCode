import { describe, expect, it } from "vite-plus/test";

import {
  alternateComposerDispatchAction,
  applyComposerQueueConstraint,
  resolveComposerDispatchMode,
} from "./composerDispatch.ts";

describe("resolveComposerDispatchMode", () => {
  it.each(["queue", "steer"] as const)(
    "queues primary and alternate %s follow-ups during recovery even with an idle presentation",
    (activeTurnDefault) => {
      expect(
        resolveComposerDispatchMode({
          running: true,
          activeTurnDefault,
          alternateModifier: false,
          forceQueue: true,
        }),
      ).toBe("queue");
      expect(alternateComposerDispatchAction(activeTurnDefault, true)).toBe("queue");
      expect(
        resolveComposerDispatchMode({
          running: false,
          activeTurnDefault,
          alternateModifier: true,
          forceQueue: true,
        }),
      ).toBe("queue");
    },
  );

  it("normalizes direct auto and steer sends during recovery without changing explicit restart", () => {
    expect(applyComposerQueueConstraint("auto", true)).toBe("queue");
    expect(applyComposerQueueConstraint("steer", true)).toBe("queue");
    expect(applyComposerQueueConstraint("queue", true)).toBe("queue");
    expect(applyComposerQueueConstraint("restart", true)).toBe("restart");
    expect(applyComposerQueueConstraint("steer", false)).toBe("steer");
    expect(
      resolveComposerDispatchMode({
        running: true,
        activeTurnDefault: "restart",
        alternateModifier: false,
        forceQueue: true,
      }),
    ).toBe("restart");
  });
});
