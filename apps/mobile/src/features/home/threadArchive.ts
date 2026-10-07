import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AsyncResult, Atom } from "effect/reactivity";
import type { threadEnvironment } from "../../state/threads";
import { resolveThreadStatus } from "../threads/thread-status";

/**
 * Standalone archive must not detach an executing provider. A family can stop
 * active work only after its authoritative child snapshot is confirmed.
 */
export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}

/** Restore a cascaded archive through its owner; provenance alone does not imply a shared archive. */
export function threadUnarchiveTargetId(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "archivedWith">,
  archivedThreads: readonly EnvironmentThreadShell[] = [],
) {
  const cohort = thread.archivedWith;
  if (!cohort || cohort.threadId === thread.id) return thread.id;
  const owner = archivedThreads.find(
    (candidate) =>
      candidate.id === cohort.threadId && candidate.environmentId === thread.environmentId,
  );
  return owner?.archivedAt != null &&
    owner.deletedAt === null &&
    owner.archivedWith?.threadId === cohort.threadId &&
    owner.archivedWith.commandId === cohort.commandId
    ? owner.id
    : thread.id;
}

type ArchiveFamilyResult =
  ReturnType<typeof threadEnvironment.archiveFamilyAtom> extends Atom.Atom<
    AsyncResult.AsyncResult<infer Value, infer _Error>
  >
    ? Value
    : never;

/** Format the server's archive choices without deciding family membership or policy. */
export function resolveThreadArchiveFamily(
  family: ArchiveFamilyResult,
  thread: EnvironmentThreadShell,
) {
  const activeChildren = family.activeChildren;
  const canKeepSeparately = family.canPromote;
  const nativeStopCount = family.nativeStopCount;
  const total = family.children.length;
  const active = activeChildren.length;
  const summary =
    active > 0
      ? `${active} ${active === 1 ? "subagent is still working or needs" : "subagents are still working or need"} your attention. Stop and archive all ${total} with this thread${canKeepSeparately ? ", or keep them running as separate threads" : ""}.`
      : `${total} ${total === 1 ? "subagent belongs" : "subagents belong"} to this thread.`;
  const activeIds = new Set(activeChildren.map((child) => child.id));
  const previewChildren = [
    ...activeChildren,
    ...family.children.filter((child) => !activeIds.has(child.id)),
  ];
  const details = previewChildren
    .slice(0, 3)
    .map(
      (child) =>
        `${child.title || "Untitled thread"} · ${resolveThreadStatus(child)?.label ?? (child.hasActionableProposedPlan ? "Plan ready" : child.pendingBackgroundTasks.length > 0 ? "Working" : "Ready")}`,
    );
  const remaining = previewChildren.length - details.length;
  if (remaining > 0) details.push(`+${remaining} more`);
  return {
    ...family,
    canKeepSeparately,
    message: [
      !threadCanArchive(thread.runtime)
        ? "This thread is still working and will stop when archived."
        : null,
      summary,
      details.join("\n"),
      nativeStopCount > 0
        ? `${nativeStopCount} provider ${nativeStopCount === 1 ? "subagent cannot" : "subagents cannot"} run on their own and will stop either way.`
        : null,
      family.protectedChildren.length > 0
        ? canKeepSeparately
          ? "Persistent subagents cannot be archived. Keep running separately preserves them."
          : "Persistent subagents cannot be archived or kept separately. Remove their persistent protection before archiving this thread."
        : null,
      "Reopening restores archived threads. Stopped work won't restart; promoted threads stay separate.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
