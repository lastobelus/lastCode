import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { buildThreadArchiveConfirmation } from "@t3tools/client-runtime/state/thread-archive";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { threadEnvironment } from "../../state/threads";

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
  Awaited<ReturnType<typeof threadEnvironment.loadArchiveFamily.run>> extends AtomCommandResult<
    infer Value,
    infer _Error
  >
    ? Value
    : never;

/** Render shared confirmation copy as native alert text. */
export function resolveThreadArchiveFamily(family: ArchiveFamilyResult) {
  const confirmation = buildThreadArchiveConfirmation(family);
  const details = confirmation.threads.map(
    ({ thread, label }) => `${thread.title || "Untitled thread"} · ${label}`,
  );
  return {
    ...family,
    confirmLabel: confirmation.confirmLabel,
    disposition: confirmation.disposition,
    blocked: confirmation.blocked,
    message: [confirmation.description, details.join("\n")].filter(Boolean).join("\n\n"),
  };
}
