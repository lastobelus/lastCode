// @effect-diagnostics nodeBuiltinImport:off -- Reads the marker written by the dependency-free installer.
// @effect-diagnostics globalDate:off -- Marker expiry compares the installer file's wall-clock mtime.
// @effect-diagnostics globalTimers:off -- This Promise-based installer handoff owns and clears its bounded polling timer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";

// The installer may use 30 seconds to launch and 10 more to reset TCC.
const PENDING_RESET_TIMEOUT_MS = 60_000;

export function screenRecordingResetMarker(home: string): string {
  return NodePath.join(home, ".lastcode", "local-updates", "screen-recording-reset");
}

function markerState(marker: string): string | null {
  try {
    return NodeFS.readFileSync(marker, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Keep reminding on launch until macOS reports the replacement app was granted access. */
export function screenRecordingReminderPending(home: string, isGranted: () => boolean): boolean {
  const marker = screenRecordingResetMarker(home);
  if (markerState(marker) !== "ready\n") return false;
  if (isGranted()) {
    NodeFS.unlinkSync(marker);
    return false;
  }
  return true;
}

/** The installer marks a reset ready only after the replacement app has launched. */
export function waitForScreenRecordingReminder(
  home: string,
  isGranted: () => boolean,
): Promise<boolean> {
  const marker = screenRecordingResetMarker(home);
  const state = markerState(marker);
  if (state === null) return Promise.resolve(false);
  if (state !== "pending\n") {
    return Promise.resolve(screenRecordingReminderPending(home, isGranted));
  }
  const remaining = Math.max(
    0,
    PENDING_RESET_TIMEOUT_MS - (Date.now() - NodeFS.statSync(marker).mtimeMs),
  );
  if (remaining === 0) {
    const current = markerState(marker);
    if (current === "pending\n") NodeFS.writeFileSync(marker, "ready\n", { mode: 0o600 });
    return Promise.resolve(screenRecordingReminderPending(home, isGranted));
  }
  return new Promise((resolve) => {
    let settled = false;
    const timeoutController = new AbortController();
    const finish = (pending: boolean) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearInterval(poll);
      timeoutController.abort();
      resolve(pending);
    };
    const check = () => {
      try {
        const current = markerState(marker);
        if (current === null) finish(false);
        else if (current === "ready\n") {
          finish(screenRecordingReminderPending(home, isGranted));
        }
      } catch {
        finish(false);
      }
    };
    // Read contents independently of watcher baselines and macOS change notifications.
    const poll = NodeTimers.setInterval(check, 250);
    void NodeTimersPromises.setTimeout(remaining, undefined, {
      signal: timeoutController.signal,
    }).then(
      () => {
        const current = markerState(marker);
        if (current === "pending\n") NodeFS.writeFileSync(marker, "ready\n", { mode: 0o600 });
        if (current === "ready\n" || current === "pending\n") check();
        else finish(false);
      },
      () => {},
    );
    check();
  });
}
