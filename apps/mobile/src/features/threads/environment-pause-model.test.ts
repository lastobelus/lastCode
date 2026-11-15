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
  status: EnvironmentPauseStatus | null,
  overrides: { enabled?: boolean; connected?: boolean; fresh?: boolean; starting?: boolean } = {},
) =>
  environmentPauseAvailability({
    status,
    enabled: true,
    connected: true,
    fresh: true,
    ...overrides,
  });

describe("mobile environment pause availability", () => {
  it.each(["pausing", "paused", "resuming"] as const)(
    "keeps Resume available in %s despite pending or failed deliveries and unfinished work",
    (phase) => {
      for (const pause of ["pending", "sent", "failed", "unavailable"] as const) {
        for (const resume of ["pending", "sent", "failed", "unavailable"] as const) {
          expect(
            availability({
              ...paused,
              quiet: false,
              activeThreadCount: 1,
              blockers: [
                {
                  type: "provider-runtime",
                  providerSessionId: ProviderSessionId.make("provider-session"),
                  status: "stopping",
                },
              ],
              session: {
                ...paused.session!,
                phase,
                targets: [{ ...paused.session!.targets[0]!, pause, resume }],
              },
            }),
          ).toMatchObject({ hasSession: true, canResume: true, canStart: false, ready: false });
        }
      }
    },
  );

  it("switches to Resume while Pause is in flight before any session is observed", () => {
    expect(availability({ ...paused, session: null }, { starting: true })).toMatchObject({
      visible: true,
      hasSession: true,
      canStart: false,
      canResume: true,
    });
    expect(availability(null, { starting: true, fresh: false })).toMatchObject({
      hasSession: true,
      known: false,
      ready: false,
      canResume: true,
    });
    expect(availability(null, { starting: true, enabled: false }).visible).toBe(true);
  });

  it("keeps a saved session resumable when the setting is off or status is stale or unknown", () => {
    for (const overrides of [{ enabled: false }, { fresh: false }]) {
      expect(availability(paused, overrides)).toMatchObject({
        visible: true,
        hasSession: true,
        canResume: true,
        canStart: false,
      });
    }
    expect(availability({ ...paused, observation: "unknown" })).toMatchObject({
      known: false,
      ready: false,
      canResume: true,
    });
    expect(availability({ ...paused, session: null }, { enabled: false })).toMatchObject({
      visible: false,
      canStart: false,
      canResume: false,
    });
  });

  it("sends Pause without waiting for a status check, with Resume reserved for an existing request", () => {
    for (const status of [null, { ...paused, session: null, observation: "unknown" as const }]) {
      expect(availability(status, { fresh: false })).toMatchObject({
        visible: true,
        known: false,
        hasSession: false,
        canStart: true,
        canResume: false,
      });
    }
  });

  it("prevents disconnected commands without claiming cached work is quiet", () => {
    expect(availability(paused, { connected: false })).toMatchObject({
      visible: true,
      hasSession: true,
      known: false,
      ready: false,
      canStart: false,
      canResume: false,
    });
    expect(availability(null, { connected: false }).canStart).toBe(false);
  });

  it("reports quiet progress separately from the ability to resume", () => {
    expect(availability(paused)).toMatchObject({ ready: true, canResume: true });
    expect(
      availability({
        ...paused,
        session: {
          ...paused.session!,
          targets: [{ ...paused.session!.targets[0]!, pause: "unavailable" }],
        },
      }),
    ).toMatchObject({ ready: true, pauseFailed: false, canResume: true });
    expect(
      availability({
        ...paused,
        session: {
          ...paused.session!,
          targets: [{ ...paused.session!.targets[0]!, pause: "failed" }],
        },
      }),
    ).toMatchObject({ ready: false, pauseFailed: true, canResume: true });
  });
});
