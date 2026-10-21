// @effect-diagnostics nodeBuiltinImport:off -- Exercises the standalone installer's filesystem marker.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it, vi } from "vite-plus/test";
import {
  screenRecordingReminderPending,
  screenRecordingResetMarker,
  waitForScreenRecordingReminder,
} from "./LastCodeScreenRecordingReminder.ts";

const TEST_EPOCH = Date.parse("2030-01-01T00:00:00Z");

it("reminds after a reset until the installed app has Screen Recording again", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    expect(screenRecordingReminderPending(home, () => false)).toBe(false);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    expect(screenRecordingReminderPending(home, () => false)).toBe(false);
    NodeFS.writeFileSync(marker, "ready\n");
    expect(screenRecordingReminderPending(home, () => false)).toBe(true);
    expect(NodeFS.existsSync(marker)).toBe(true);
    expect(screenRecordingReminderPending(home, () => true)).toBe(false);
    expect(NodeFS.existsSync(marker)).toBe(false);
  } finally {
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});

it("waits for the installer to finish resetting before showing the reminder", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const reminder = waitForScreenRecordingReminder(home, () => false);
    NodeFS.writeFileSync(marker, "ready\n");
    expect(await reminder).toBe(true);
    expect(NodeFS.existsSync(marker)).toBe(true);
  } finally {
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});

it("reads an immediate rewrite without waiting for a file change notification", async () => {
  vi.useFakeTimers({ now: TEST_EPOCH });
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const timestamp = (TEST_EPOCH - 1_000) / 1_000;
    NodeFS.utimesSync(marker, timestamp, timestamp);
    const reminder = waitForScreenRecordingReminder(home, () => false);
    NodeFS.writeFileSync(marker, "ready\n");
    NodeFS.utimesSync(marker, timestamp, timestamp);
    await vi.advanceTimersByTimeAsync(250);
    expect(await reminder).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});

it("waits for a near-deadline installer to finish", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(TEST_EPOCH);
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const nearLaunchDeadline = (TEST_EPOCH - 31_000) / 1_000;
    NodeFS.utimesSync(marker, nearLaunchDeadline, nearLaunchDeadline);
    const reminder = waitForScreenRecordingReminder(home, () => false);
    NodeFS.writeFileSync(marker, "ready\n");
    expect(await reminder).toBe(true);
  } finally {
    clock.mockRestore();
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});

it("reminds when an installer stops after installing a build without permission", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(TEST_EPOCH);
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const expired = (TEST_EPOCH - 61_000) / 1_000;
    NodeFS.utimesSync(marker, expired, expired);
    expect(await waitForScreenRecordingReminder(home, () => false)).toBe(true);
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("ready\n");
  } finally {
    clock.mockRestore();
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});

it("clears an expired pending marker when the installed app already has permission", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(TEST_EPOCH);
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const expired = (TEST_EPOCH - 61_000) / 1_000;
    NodeFS.utimesSync(marker, expired, expired);
    expect(await waitForScreenRecordingReminder(home, () => true)).toBe(false);
    expect(NodeFS.existsSync(marker)).toBe(false);
  } finally {
    clock.mockRestore();
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});
