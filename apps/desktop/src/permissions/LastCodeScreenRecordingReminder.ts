// @effect-diagnostics nodeBuiltinImport:off -- Reads the marker written by the dependency-free installer.
// @effect-diagnostics globalDate:off -- Marker expiry compares the installer file's wall-clock mtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const PENDING_RESET_TIMEOUT_MS = 30_000;

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
    if (current === "ready\n") {
      return Promise.resolve(screenRecordingReminderPending(home, isGranted));
    }
    if (current === "pending\n") NodeFS.rmSync(marker, { force: true });
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timeoutController = new AbortController();
    const finish = (pending: boolean) => {
      if (settled) return;
      settled = true;
      watcher.close();
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
    const watcher = NodeFS.watch(NodePath.dirname(marker), (_event, file) => {
      if (file === NodePath.basename(marker)) check();
    });
    watcher.on("error", () => finish(false));
    void NodeTimersPromises.setTimeout(remaining, undefined, {
      signal: timeoutController.signal,
    }).then(
      () => {
        const current = markerState(marker);
        if (current === "ready\n") check();
        else {
          if (current === "pending\n") NodeFS.rmSync(marker, { force: true });
          finish(false);
        }
      },
      () => {},
    );
    check();
  });
}
