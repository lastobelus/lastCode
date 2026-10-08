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

  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ running: false, alternateModifier: false })).toBe("auto");
  });

  it("steers by default and reserves Mod+Enter for queueing while running", () => {
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: false })).toBe("steer");
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: true })).toBe("queue");
  });

  it("queues as the alternate action when restarting is the default", () => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: true,
        activeTurnDefault: "restart",
      }),
    ).toBe("queue");
  });
  it.each([
    ["queue", "steer"],
    ["steer", "queue"],
  ] as const)(
    "uses configured %s behavior only during a running turn",
    (activeTurnDefault, alternateAction) => {
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe(activeTurnDefault);
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: true,
          activeTurnDefault,
        }),
      ).toBe(alternateAction);
      expect(
        resolveComposerDispatchMode({
          running: false,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe("auto");
      expect(
        resolveComposerDispatchMode({ running: false, alternateModifier: true, activeTurnDefault }),
      ).toBe("auto");
    },
  );

  it("names the alternate action so the affordance can be labelled", () => {
    expect(alternateComposerDispatchAction("queue")).toBe("steer");
    expect(alternateComposerDispatchAction("steer")).toBe("queue");
    expect(alternateComposerDispatchAction()).toBe("queue");
  });
});
