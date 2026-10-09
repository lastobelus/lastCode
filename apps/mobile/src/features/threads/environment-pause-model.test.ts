import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderSessionId,
  ThreadId,
  type EnvironmentPauseStatus,
} from "@t3tools/contracts";

import { environmentPauseAvailability } from "./environment-pause-model";

const paused: EnvironmentPauseStatus = {
  session: {
    id: "pause-session",
    createdAt: "2026-10-08T00:00:00.000Z",
    phase: "paused",
    targets: [
      {
        threadId: ThreadId.make("thread"),
        projectId: ProjectId.make("project"),
        title: "Saved work",
        pause: "sent",
        resume: "pending",
        error: null,
      },
    ],
  },
  activeThreadCount: 0,
  blockers: [],
  quiet: true,
  observation: "known",
};

const availability = (
  status: EnvironmentPauseStatus,
  overrides: { enabled?: boolean; connected?: boolean; fresh?: boolean } = {},
) =>
  environmentPauseAvailability({
    status,
    enabled: true,
    connected: true,
    fresh: true,
    ...overrides,
  });

describe("mobile environment pause availability", () => {
  it("keeps a saved pause session resumable when the setting is turned off", () => {
    expect(availability(paused, { enabled: false })).toMatchObject({
      visible: true,
      ready: true,
      canResume: true,
      canStart: false,
    });
    expect(availability({ ...paused, session: null }, { enabled: false }).visible).toBe(false);
  });

  it.each([{ connected: false }, { fresh: false }])(
    "does not trust cached quiet state while unavailable: %j",
    (overrides) => {
      expect(availability(paused, overrides)).toMatchObject({
        visible: true,
        ready: false,
        canResume: false,
        canRetryPause: false,
      });
    },
  );

  it("treats unknown observation and work outside the paused threads as unfinished", () => {
    expect(availability({ ...paused, observation: "unknown" }).canResume).toBe(false);
    expect(
      availability({
        ...paused,
        quiet: false,
        blockers: [
          {
            type: "provider-runtime",
            providerSessionId: ProviderSessionId.make("provider-session"),
            status: "stopping",
          },
        ],
      }),
    ).toMatchObject({ ready: false, canResume: false });
  });

  it("waits for pause delivery to settle before offering resume", () => {
    expect(
      availability({ ...paused, session: { ...paused.session!, phase: "pausing" } }).canResume,
    ).toBe(false);
    expect(
      availability({
        ...paused,
        session: {
          ...paused.session!,
          targets: [{ ...paused.session!.targets[0]!, pause: "failed" }],
        },
      }),
    ).toMatchObject({ ready: false, canRetryPause: true, canResume: false });
  });

  it("allows a failed resume to retry while earlier recipients are already working", () => {
    expect(
      availability({
        ...paused,
        quiet: false,
        activeThreadCount: 1,
        session: {
          ...paused.session!,
          phase: "resuming",
          targets: [{ ...paused.session!.targets[0]!, resume: "failed" }],
        },
      }),
    ).toMatchObject({ ready: false, canResume: true, canRetryPause: false });
  });
});
