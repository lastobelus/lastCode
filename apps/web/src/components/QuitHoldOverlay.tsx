import { useSyncExternalStore } from "react";

import { isMacPlatform } from "../lib/utils";

const HOLD_HINT_LINGER_MS = 1200;

type QuitHintMode = "hold" | "double-click";

let quitHint: { mode: QuitHintMode | null; runningActionCount: number } = {
  mode: null,
  runningActionCount: 0,
};
let pressedMode: QuitHintMode = "hold";
let hideTimer: number | undefined;
const listeners = new Set<() => void>();
let stopBridge: (() => void) | null = null;

function setVisibleMode(
  next: QuitHintMode | null,
  runningActionCount = quitHint.runningActionCount,
) {
  if (next === quitHint.mode && runningActionCount === quitHint.runningActionCount) return;
  quitHint = { mode: next, runningActionCount };
  for (const listener of listeners) listener();
}

function subscribeQuitHint(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    stopBridge =
      window.desktopBridge?.onQuitShortcut((hint, runningActionCount) => {
        window.clearTimeout(hideTimer);
        if (hint.state === "down") {
          pressedMode = hint.mode;
          setVisibleMode(hint.mode, runningActionCount);
          return;
        }
        if (pressedMode === "double-click") {
          setVisibleMode(null, runningActionCount);
          return;
        }
        setVisibleMode(quitHint.mode, runningActionCount);
        hideTimer = window.setTimeout(() => setVisibleMode(null), HOLD_HINT_LINGER_MS);
      }) ?? null;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.clearTimeout(hideTimer);
    stopBridge?.();
    stopBridge = null;
    quitHint = { mode: null, runningActionCount: 0 };
  };
}

const readQuitHint = () => quitHint;

export function QuitHoldOverlay() {
  const { mode: visibleMode, runningActionCount } = useSyncExternalStore(
    subscribeQuitHint,
    readQuitHint,
    readQuitHint,
  );

  if (!visibleMode) return null;
  const shortcut = isMacPlatform(navigator.platform) ? "⌘Q" : "Ctrl+Q";
  const message =
    visibleMode === "hold"
      ? `Hold ${shortcut} or press twice to quit`
      : `Press ${shortcut} again to quit`;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center"
    >
      <div className="rounded-full bg-foreground/95 px-8 py-4 text-2xl font-bold text-background shadow-xl">
        {message}
        {runningActionCount > 0
          ? ` and cancel ${runningActionCount} running ${runningActionCount === 1 ? "Action" : "Actions"}`
          : ""}
      </div>
    </div>
  );
}
