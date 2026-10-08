import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import type { GitActionProgress } from "./use-vcs-action-state";

const EMPTY_FEEDBACK: GitActionProgress = { phase: "idle", label: null, description: null };
const MIN_VISIBLE_MS = 3_000;

export const stopThreadProcessesFeedbackAtom = Atom.make(EMPTY_FEEDBACK).pipe(Atom.keepAlive);

interface FeedbackRequest {
  readonly threadTitle: string;
  readonly startedAt: number;
  phase: "running" | "success" | "error";
}

const requests = new Set<FeedbackRequest>();

function publishFeedback() {
  if (requests.size === 0) {
    appAtomRegistry.set(stopThreadProcessesFeedbackAtom, EMPTY_FEEDBACK);
    return;
  }
  const counts = { running: 0, success: 0, error: 0 };
  for (const request of requests) counts[request.phase] += 1;
  const phase = counts.running > 0 ? "running" : counts.error > 0 ? "error" : "success";
  appAtomRegistry.set(stopThreadProcessesFeedbackAtom, {
    phase,
    label:
      phase === "running"
        ? "Stopping all previews and processes…"
        : phase === "success"
          ? "All previews and processes stopped"
          : "Could not confirm previews and processes stopped",
    description:
      requests.size === 1
        ? (requests.values().next().value?.threadTitle ?? null)
        : [
            counts.running > 0 ? `${counts.running} stopping` : null,
            counts.success > 0 ? `${counts.success} stopped` : null,
            counts.error > 0 ? `${counts.error} failed` : null,
          ]
            .filter((count) => count !== null)
            .join(" · "),
  });
}

/** Feedback lives above recycled rows and stays pending until shutdown completes. */
export function beginStopThreadProcessesFeedback(threadTitle: string) {
  const request: FeedbackRequest = {
    threadTitle,
    startedAt: Date.now(),
    phase: "running",
  };
  requests.add(request);
  publishFeedback();

  return (phase: "success" | "error" | "interrupted") => {
    if (!requests.has(request) || request.phase !== "running") return;
    if (phase === "interrupted") {
      requests.delete(request);
      publishFeedback();
      return;
    }
    request.phase = phase;
    publishFeedback();
    setTimeout(
      () => {
        requests.delete(request);
        publishFeedback();
      },
      Math.max(0, MIN_VISIBLE_MS - (Date.now() - request.startedAt)),
    );
  };
}
