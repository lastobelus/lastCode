import { describe, expect, it, vi } from "vite-plus/test";

import {
  dailyCheckpointDecision,
  parseCheckpointScheduleArgs,
  runCheckpointSchedule,
  wallClockAt,
} from "./lastcode-checkpoint-schedule.mjs";

const schedule = { dailyAt: "02:00", timeZone: "America/Los_Angeles" };

describe("daily checkpoint schedule", () => {
  it("parses a daily wall clock and IANA time zone", () => {
    expect(
      parseCheckpointScheduleArgs([
        "run",
        "--daily-at",
        "02:00",
        "--time-zone",
        "America/Los_Angeles",
      ]),
    ).toEqual(schedule);
    expect(() =>
      parseCheckpointScheduleArgs([
        "run",
        "--daily-at",
        "2:00",
        "--time-zone",
        "America/Los_Angeles",
      ]),
    ).toThrow("HH:MM");
    expect(() =>
      parseCheckpointScheduleArgs(["run", "--daily-at", "02:00", "--time-zone", "Not/A_Zone"]),
    ).toThrow("IANA time zone");
  });

  it("resolves the configured wall clock independently of the host time zone", () => {
    expect(wallClockAt(new Date("2026-01-15T10:00:00Z"), "America/Los_Angeles")).toEqual({
      date: "2026-01-15",
      time: "02:00",
    });
    expect(wallClockAt(new Date("2026-07-15T09:00:00Z"), "America/Los_Angeles")).toEqual({
      date: "2026-07-15",
      time: "02:00",
    });
  });

  it("runs once per local date at or after the configured time", () => {
    expect(
      dailyCheckpointDecision({
        ...schedule,
        forced: false,
        instant: new Date("2026-01-15T09:59:00Z"),
        state: null,
      }),
    ).toMatchObject({ run: false });
    const due = dailyCheckpointDecision({
      ...schedule,
      forced: false,
      instant: new Date("2026-01-15T10:00:00Z"),
      state: null,
    });
    expect(due).toEqual({ localDate: "2026-01-15", reason: "scheduled", run: true });
    expect(
      dailyCheckpointDecision({
        ...schedule,
        forced: false,
        instant: new Date("2026-01-15T18:00:00Z"),
        state: { lastAttemptedLocalDate: "2026-01-15" },
      }),
    ).toMatchObject({ run: false });
  });

  it("runs after a missing spring-forward time and only once through a repeated fall hour", () => {
    expect(
      dailyCheckpointDecision({
        dailyAt: "02:30",
        timeZone: "America/Los_Angeles",
        forced: false,
        instant: new Date("2026-03-08T10:00:00Z"),
        state: null,
      }),
    ).toEqual({ localDate: "2026-03-08", reason: "scheduled", run: true });

    const repeatedSchedule = { dailyAt: "01:30", timeZone: "America/Los_Angeles" };
    expect(
      dailyCheckpointDecision({
        ...repeatedSchedule,
        forced: false,
        instant: new Date("2026-11-01T08:30:00Z"),
        state: null,
      }),
    ).toMatchObject({ run: true });
    expect(
      dailyCheckpointDecision({
        ...repeatedSchedule,
        forced: false,
        instant: new Date("2026-11-01T09:30:00Z"),
        state: { lastAttemptedLocalDate: "2026-11-01" },
      }),
    ).toMatchObject({ run: false });
  });

  it("consumes a manual request once and counts it for the day only after the scheduled time", () => {
    const beforeDue = {
      instant: () => new Date("2026-01-15T09:00:00Z"),
      readState: () => null,
      removeRequest: vi.fn(),
      requestExists: () => true,
      runSupervisor: vi.fn(),
      writeState: vi.fn(),
    };
    expect(runCheckpointSchedule(schedule, beforeDue)).toMatchObject({
      reason: "manual",
      run: true,
    });
    expect(beforeDue.removeRequest).toHaveBeenCalledOnce();
    expect(beforeDue.runSupervisor).toHaveBeenCalledOnce();
    expect(beforeDue.writeState).not.toHaveBeenCalled();

    const afterDue = {
      ...beforeDue,
      instant: () => new Date("2026-01-15T10:01:00Z"),
      removeRequest: vi.fn(),
      runSupervisor: vi.fn(),
      writeState: vi.fn(),
    };
    runCheckpointSchedule(schedule, afterDue);
    expect(afterDue.writeState).toHaveBeenCalledWith({
      schemaVersion: 1,
      lastAttemptedLocalDate: "2026-01-15",
    });
  });

  it("does not retry a failed scheduled checkpoint on the next tick", () => {
    let state = null;
    const dependencies = {
      instant: () => new Date("2026-01-15T10:01:00Z"),
      readState: () => state,
      requestExists: () => false,
      runSupervisor: vi.fn(() => {
        throw new Error("checkpoint conflict");
      }),
      writeState: (next) => {
        state = next;
      },
    };
    expect(() => runCheckpointSchedule(schedule, dependencies)).toThrow("checkpoint conflict");
    expect(runCheckpointSchedule(schedule, dependencies)).toMatchObject({ run: false });
    expect(dependencies.runSupervisor).toHaveBeenCalledOnce();
  });
});
