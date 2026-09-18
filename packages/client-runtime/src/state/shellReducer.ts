import * as Arr from "effect/Array";
import type {
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

function upsertThreadShells(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  updates: ReadonlyArray<OrchestrationThreadShell>,
): ReadonlyArray<OrchestrationThreadShell> {
  return updates.reduce(
    (current, nextThread) =>
      current.some((thread) => thread.id === nextThread.id)
        ? Arr.map(current, (thread) => (thread.id === nextThread.id ? nextThread : thread))
        : Arr.append(current, nextThread),
    threads,
  );
}

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = upsertThreadShells(snapshot.threads, [
        event.thread,
        ...(event.relatedThreads ?? []),
      ]);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed": {
      const refreshedThreads = upsertThreadShells(snapshot.threads, event.relatedThreads ?? []);
      return {
        ...snapshot,
        threads: Arr.filter(refreshedThreads, (thread) => thread.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    }
    default:
      return snapshot;
  }
}
