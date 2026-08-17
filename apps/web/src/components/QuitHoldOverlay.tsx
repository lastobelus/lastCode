import { useEffect, useState } from "react";

import { isMacPlatform } from "../lib/utils";

// Matches the hold duration in apps/desktop/src/window/QuitHold.ts: the hint
// from a quick tap lingers for as long as a full hold would have taken.
const HIDE_AFTER_RELEASE_MS = 1200;

/**
 * Chrome-style "Hold ⌘Q to Quit" hint. The desktop main process intercepts
 * the quit accelerator and pushes press/release states; a quick tap shows
 * this pill while a full hold quits the app.
 */
export function QuitHoldOverlay() {
  const [visible, setVisible] = useState(false);
  const [runningActionCount, setRunningActionCount] = useState(0);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitShortcut;
    if (!subscribe) return;
    let hideTimer: number | undefined;
    const unsubscribe = subscribe((state, nextRunningActionCount) => {
      window.clearTimeout(hideTimer);
      setRunningActionCount(nextRunningActionCount);
      if (state === "down") {
        setVisible(true);
        return;
      }
      hideTimer = window.setTimeout(() => setVisible(false), HIDE_AFTER_RELEASE_MS);
    });
    return () => {
      window.clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  if (!visible) return null;
  const shortcut = isMacPlatform(navigator.platform) ? "⌘Q" : "Ctrl+Q";
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center"
    >
      <div className="rounded-full bg-neutral-700/95 px-8 py-4 text-2xl font-bold text-white shadow-xl">
        Hold {shortcut} to Quit
        {runningActionCount > 0
          ? ` and cancel ${runningActionCount} running ${runningActionCount === 1 ? "Action" : "Actions"}`
          : ""}
      </div>
    </div>
  );
}
