import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { msg, useMessages } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";
import { appAtomRegistry } from "./atom-registry";
import type { GitActionProgress } from "./use-vcs-action-state";

const EMPTY_FEEDBACK: GitActionProgress = { phase: "idle", label: null, description: null };
const MIN_VISIBLE_MS = 3_000;

const stopThreadProcessesFeedbackState = Atom.make<{
  readonly progress: GitActionProgress;
  readonly present?: (resolve: MessageResolver) => GitActionProgress;
}>({ progress: EMPTY_FEEDBACK }).pipe(Atom.keepAlive);

export const stopThreadProcessesFeedbackAtom = Atom.make(
  (get) => get(stopThreadProcessesFeedbackState).progress,
).pipe(Atom.keepAlive);

export function useStopThreadProcessesFeedback(): GitActionProgress {
  const snapshot = useAtomValue(stopThreadProcessesFeedbackState);
  const resolve = useMessages();
  return snapshot.present?.(resolve) ?? snapshot.progress;
}

interface FeedbackRequest {
  readonly threadTitle: string;
  readonly startedAt: number;
  phase: "running" | "success" | "error";
}

const requests = new Set<FeedbackRequest>();

function publishFeedback() {
  if (requests.size === 0) {
    appAtomRegistry.set(stopThreadProcessesFeedbackState, { progress: EMPTY_FEEDBACK });
    return;
  }
  const counts = { running: 0, success: 0, error: 0 };
  for (const request of requests) counts[request.phase] += 1;
  const phase = counts.running > 0 ? "running" : counts.error > 0 ? "error" : "success";
  const singleRequest = requests.size === 1 ? requests.values().next().value : undefined;
  const present = (resolve: MessageResolver): GitActionProgress => ({
    phase,
    label:
      phase === "running"
        ? resolve(msg("Stopping all previews and processes…"))
        : phase === "success"
          ? resolve(msg("All previews and processes stopped"))
          : resolve(msg("Could not confirm previews and processes stopped")),
    description: singleRequest
      ? singleRequest.threadTitle
      : [
          counts.running > 0 ? resolve(msg("{count} stopping", { count: counts.running })) : null,
          counts.success > 0 ? resolve(msg("{count} stopped", { count: counts.success })) : null,
          counts.error > 0 ? resolve(msg("{count} failed", { count: counts.error })) : null,
        ]
          .filter((count) => count !== null)
          .join(" · "),
  });
  appAtomRegistry.set(stopThreadProcessesFeedbackState, { progress: present(m), present });
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
