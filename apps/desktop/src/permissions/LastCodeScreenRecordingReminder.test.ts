// @effect-diagnostics nodeBuiltinImport:off -- Exercises the standalone installer's filesystem marker.
// @effect-diagnostics globalDate:off -- Exercises a marker with an expired filesystem mtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";
import {
  screenRecordingReminderPending,
  screenRecordingResetMarker,
  waitForScreenRecordingReminder,
} from "./LastCodeScreenRecordingReminder.ts";

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

it("waits for a near-deadline installer to finish", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const nearLaunchDeadline = new Date(Date.now() - 31_000);
    NodeFS.utimesSync(marker, nearLaunchDeadline, nearLaunchDeadline);
    const reminder = waitForScreenRecordingReminder(home, () => false);
    NodeFS.writeFileSync(marker, "ready\n");
    expect(await reminder).toBe(true);
  } finally {
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});

it("reminds when an installer stops after installing a build without permission", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const expired = new Date(Date.now() - 61_000);
    NodeFS.utimesSync(marker, expired, expired);
    expect(await waitForScreenRecordingReminder(home, () => false)).toBe(true);
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("ready\n");
  } finally {
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});

it("clears an expired pending marker when the installed app already has permission", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-permission-test-"));
  try {
    const marker = screenRecordingResetMarker(home);
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "pending\n");
    const expired = new Date(Date.now() - 61_000);
    NodeFS.utimesSync(marker, expired, expired);
    expect(await waitForScreenRecordingReminder(home, () => true)).toBe(false);
    expect(NodeFS.existsSync(marker)).toBe(false);
  } finally {
    NodeFS.rmSync(home, { force: true, recursive: true });
  }
});
