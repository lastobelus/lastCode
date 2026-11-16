import { describe, expect, it } from "vite-plus/test";

import {
  alternateComposerDispatchAction,
  applyComposerQueueConstraint,
  compactionBlocksSteering,
  resolveComposerDispatchMode,
} from "./composerDispatch.ts";

it("blocks steering for explicit compaction, and for automatic compaction unless the provider takes steers then", () => {
  const during = (
    text: string | undefined,
    attachments: ReadonlyArray<unknown> = [],
    steersDuringCompaction = true,
  ) =>
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: true,
      steersDuringCompaction,
      run: { userMessageId: "user" },
      messages: [
        ...(text === undefined ? [] : [{ id: "user", text, attachments }]),
        { id: "later", text: "/compact" },
      ],
    });

  for (const text of ["/compact", "  /COMPACT  ", "/compact keep the debugging notes"]) {
    expect(during(text)).toBe(true);
  }
  for (const text of ["Read the code", "/compactify", "please /compact", undefined]) {
    expect(during(text)).toBe(false);
  }
  expect(during("/compact", [{}])).toBe(false);
  expect(during("Read the code", [], false)).toBe(true);

  expect(
    compactionBlocksSteering({
      compactCommandIsActive: true,
      compactionRunning: false,
      steersDuringCompaction: true,
      run: undefined,
      messages: undefined,
    }),
  ).toBe(true);
  expect(
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: false,
      steersDuringCompaction: false,
      run: { userMessageId: "user" },
      messages: [{ id: "user", text: "/compact" }],
    }),
  ).toBe(false);
});

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
