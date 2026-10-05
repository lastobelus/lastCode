import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";
import type { GitActionProgress } from "./use-vcs-action-state";

const EMPTY_FEEDBACK: GitActionProgress = { phase: "idle", label: null, description: null };
const MIN_VISIBLE_MS = 3_000;

export const stopThreadProcessesFeedbackAtom = Atom.make(EMPTY_FEEDBACK).pipe(Atom.keepAlive);
let currentRequest: object | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

/** Feedback lives above recycled rows and stays pending until shutdown completes. */
export function beginStopThreadProcessesFeedback(threadTitle: string) {
  const request = {};
  currentRequest = request;
  if (dismissTimer !== null) clearTimeout(dismissTimer);
  dismissTimer = null;
  const startedAt = Date.now();
  appAtomRegistry.set(stopThreadProcessesFeedbackAtom, {
    phase: "running",
    label: "Stopping all previews and processes…",
    description: threadTitle,
  });

  return (phase: "success" | "error" | "interrupted") => {
    if (currentRequest !== request) return;
    if (phase === "interrupted") {
      if (dismissTimer !== null) clearTimeout(dismissTimer);
      dismissTimer = null;
      currentRequest = null;
      appAtomRegistry.set(stopThreadProcessesFeedbackAtom, EMPTY_FEEDBACK);
      return;
    }
    appAtomRegistry.set(stopThreadProcessesFeedbackAtom, {
      phase,
      label:
        phase === "success"
          ? "All previews and processes stopped"
          : "Could not confirm previews and processes stopped",
      description: threadTitle,
    });
    dismissTimer = setTimeout(
      () => {
        dismissTimer = null;
        currentRequest = null;
        appAtomRegistry.set(stopThreadProcessesFeedbackAtom, EMPTY_FEEDBACK);
      },
      Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt)),
    );
  };
}
