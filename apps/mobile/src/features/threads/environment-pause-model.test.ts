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
  it("offers Resume after unavailable pause recipients retire without retrying them", () => {
    const quiet: EnvironmentPauseStatus = {
      ...paused,
      session: {
        ...paused.session!,
        targets: [
          ...paused.session!.targets,
          {
            ...paused.session!.targets[0]!,
            threadId: ThreadId.make("archived-before-pause"),
            pause: "unavailable",
            error: "Archived before the pause message was delivered.",
          },
        ],
      },
    };
    expect(availability(quiet)).toMatchObject({
      ready: true,
      canResume: true,
      pauseFailed: false,
      showRetryPause: false,
      showCancelPause: false,
    });
    expect(
      availability({
        ...quiet,
        session: { ...quiet.session!, phase: "pausing" },
        activeThreadCount: 1,
        quiet: false,
      }),
    ).toMatchObject({
      ready: false,
      canResume: false,
      showPauseRemaining: true,
    });
  });

  it("can pause again after resume messages settle while released work is queued", () => {
    const resuming: EnvironmentPauseStatus = {
      ...paused,
      quiet: false,
      session: {
        ...paused.session!,
        phase: "resuming",
        targets: [{ ...paused.session!.targets[0]!, resume: "sent" }],
      },
    };
    expect(availability(resuming)).toMatchObject({
      showPauseAgain: true,
      canPauseAgain: true,
      canStart: true,
    });
    expect(availability(resuming, { fresh: false }).canPauseAgain).toBe(false);
    expect(availability(resuming, { enabled: false }).showPauseAgain).toBe(false);
    expect(
      availability({
        ...resuming,
        session: {
          ...resuming.session!,
          targets: [{ ...resuming.session!.targets[0]!, resume: "pending" }],
        },
      }).showPauseAgain,
    ).toBe(false);
  });

  it("keeps a saved pause session resumable when the setting is turned off", () => {
    expect(availability(paused, { enabled: false })).toMatchObject({
      visible: true,
      ready: true,
      canResume: true,
      canStart: false,
      showCancelPause: false,
      canCancelPause: false,
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
        canCancelPause: false,
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
    ).toMatchObject({ ready: false, canResume: true, canRetryPause: false, canCancelPause: false });
  });

  it("lets a stalled pause resume its successful recipients despite a permanent delivery failure", () => {
    expect(
      availability({
        ...paused,
        quiet: false,
        activeThreadCount: 1,
        session: {
          ...paused.session!,
          phase: "pausing",
          targets: [
            paused.session!.targets[0]!,
            {
              ...paused.session!.targets[0]!,
              threadId: ThreadId.make("unavailable-thread"),
              pause: "failed",
              error: "Thread is unavailable.",
            },
          ],
        },
      }),
    ).toMatchObject({
      ready: false,
      canResume: false,
      showCancelPause: true,
      canCancelPause: true,
    });
  });

  it("allows cancellation when settled pause messages leave a thread waiting for an approval", () => {
    const status: EnvironmentPauseStatus = {
      ...paused,
      quiet: false,
      activeThreadCount: 1,
      session: { ...paused.session!, phase: "pausing" },
      blockers: [
        { type: "thread-turn", threadId: ThreadId.make("thread"), turnId: null, status: "running" },
      ],
    };
    expect(availability(status)).toMatchObject({
      ready: false,
      canResume: false,
      canCancelPause: true,
    });
    expect(availability({ ...status, observation: "unknown" }).canCancelPause).toBe(false);
    expect(availability(status, { connected: false }).canCancelPause).toBe(false);
    expect(availability(status, { fresh: false }).canCancelPause).toBe(false);
  });

  it("does not cancel while pause delivery is still pending", () => {
    expect(
      availability({
        ...paused,
        quiet: false,
        session: {
          ...paused.session!,
          phase: "pausing",
          targets: [{ ...paused.session!.targets[0]!, pause: "pending" }],
        },
      }),
    ).toMatchObject({ showCancelPause: false, canCancelPause: false, canResume: false });
  });

  it("can pause newly active threads when the saved targets have no delivery failures", () => {
    const status: EnvironmentPauseStatus = {
      ...paused,
      quiet: false,
      activeThreadCount: 1,
      session: { ...paused.session!, phase: "pausing" },
      blockers: [
        {
          type: "thread-turn",
          threadId: ThreadId.make("newly-active-thread"),
          turnId: null,
          status: "running",
        },
      ],
    };
    expect(availability(status)).toMatchObject({
      pauseFailed: false,
      showPauseRemaining: true,
      showRetryPause: true,
      canRetryPause: true,
    });
    expect(availability(status, { enabled: false }).canRetryPause).toBe(true);
    expect(availability(status, { connected: false }).canRetryPause).toBe(false);
    expect(availability(status, { fresh: false }).canRetryPause).toBe(false);
    expect(availability({ ...status, observation: "unknown" }).canRetryPause).toBe(false);
  });

  it("does not collect more pause targets after work becomes quiet or resuming starts", () => {
    expect(availability(paused)).toMatchObject({
      showPauseRemaining: false,
      showRetryPause: false,
      canRetryPause: false,
    });
    expect(availability({ ...paused, session: null })).toMatchObject({
      showRetryPause: false,
      canRetryPause: false,
    });
    expect(
      availability({ ...paused, quiet: false, session: { ...paused.session!, phase: "resuming" } }),
    ).toMatchObject({ showPauseRemaining: false, showRetryPause: false, canRetryPause: false });
  });

  it("does not retry unavailable resume recipients while another delivery is pending", () => {
    const status: EnvironmentPauseStatus = {
      ...paused,
      session: {
        ...paused.session!,
        phase: "resuming",
        targets: [
          { ...paused.session!.targets[0]!, resume: "unavailable" },
          {
            ...paused.session!.targets[0]!,
            threadId: ThreadId.make("pending-thread"),
            resume: "pending",
          },
        ],
      },
    };
    expect(availability(status)).toMatchObject({
      resumeFailed: false,
      canResume: false,
      canCancelPause: false,
    });
    expect(
      availability({
        ...status,
        session: {
          ...status.session!,
          targets: [
            status.session!.targets[0]!,
            { ...status.session!.targets[1]!, resume: "failed" },
          ],
        },
      }),
    ).toMatchObject({ resumeFailed: true, canResume: true });
  });
});
