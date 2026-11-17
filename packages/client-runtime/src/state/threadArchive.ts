import { formatThreadLink } from "@t3tools/shared/threadLinks";
import {
  CommandId,
  MessageId,
  type ScopedThreadRef,
  type ThreadArchiveConsultationTarget,
  type ThreadId,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "../operations/commands.ts";
import type { createThreadEnvironmentAtoms } from "./threadCommands.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export const THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE =
  "Update this environment's server before archiving thread families safely.";

/** One shared presentation for web and mobile; family membership and activity come from the server. */
export function buildThreadArchiveConfirmation<
  T extends Pick<EnvironmentThreadShell, "id" | "title" | "persistent">,
>(family: {
  readonly threads: readonly T[];
  readonly children: readonly T[];
  readonly activeThreadIds: readonly string[];
  readonly unreadThreadIds: readonly string[];
  readonly protectedChildThreadIds: readonly string[];
  readonly canStopAndArchive: boolean;
}) {
  const activeIds = new Set(family.activeThreadIds);
  const unreadIds = new Set(family.unreadThreadIds);
  const active = activeIds.size > 0;
  const unread = unreadIds.size > 0;
  const blocked = !family.canStopAndArchive;
  const protectedThreads = family.threads.filter((thread) => thread.persistent);
  const summary = blocked
    ? `${protectedThreads.length === 1 ? `${protectedThreads[0]!.title || "This thread"} is` : `${protectedThreads.length} threads are`} persistent and can't be archived. Remove persistent protection, then try again.`
    : active
      ? `${activeIds.size} ${activeIds.size === 1 ? "thread is" : "threads are"} still working. Archiving stops ${activeIds.size === 1 ? "it" : "them"}, cancels pending approvals and queued messages, and archives the whole family.${unread ? " Unread replies stay in archived history." : ""}`
      : `${unreadIds.size} ${unreadIds.size === 1 ? "thread has" : "threads have"} replies you haven't read. Archiving closes the whole family. Replies stay in archived history.`;
  return {
    blocked,
    active,
    description: blocked
      ? summary
      : `${summary} Unarchiving reopens history. Stopped work won't restart.`,
    confirmLabel: active ? "Stop active threads & archive" : "Archive unread threads",
    disposition: active ? ("stop_and_archive" as const) : ("archive_after_review" as const),
    threads: family.threads
      .filter((thread) =>
        blocked ? thread.persistent : activeIds.has(thread.id) || unreadIds.has(thread.id),
      )
      .map((thread) => ({
        thread,
        label: blocked
          ? "Persistent"
          : [
              activeIds.has(thread.id) ? "Working" : null,
              unreadIds.has(thread.id) ? "Unread" : null,
            ]
              .filter(Boolean)
              .join(" · "),
      })),
  };
}

type ArchiveRecoveryThread = Pick<EnvironmentThreadShell, "lineage" | "archivePending"> & {
  readonly id: string;
  readonly environmentId?: string;
  readonly archivedAt: unknown | null;
  readonly deletedAt: unknown | null;
};

/** Keep pending owned archive roots and stranded participants reachable without releasing ownership. */
export function getArchiveRecoveryRows<T extends ArchiveRecoveryThread>(threads: readonly T[]) {
  const key = (environmentId: string | undefined, id: string) =>
    `${environmentId ?? ""}\u0000${id}`;
  const owners = new Map(threads.map((thread) => [key(thread.environmentId, thread.id), thread]));
  return new Set(
    threads.filter((thread) => {
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        !thread.archivePending ||
        thread.lineage.relationshipToParent !== "subagent" ||
        thread.lineage.independent === true
      )
        return false;
      const owner = owners.get(key(thread.environmentId, thread.archivePending.threadId));
      return (
        thread.archivePending.threadId === thread.id ||
        owner === undefined ||
        owner.archivedAt !== null ||
        owner.deletedAt !== null
      );
    }),
  );
}

/** Every failed participant retries the original owner, including an archived repair owner. */
export function archiveRetryThreadId(
  thread: Pick<EnvironmentThreadShell, "id" | "archivePending">,
) {
  return thread.archivePending?.status === "failed" ? thread.archivePending.threadId : thread.id;
}

/** Persisted shutdown progress remains visible after the initiating client disconnects. */
export function presentThreadArchive(thread: Pick<EnvironmentThreadShell, "archivePending">) {
  const pending = thread.archivePending;
  if (!pending) return null;
  if (pending.status === "stopping")
    return {
      status: "archiving" as const,
      label: "Archiving…" as const,
      description: "Stopping provider work before archiving this thread family.",
    };
  return {
    status: "archive-failed" as const,
    label: "Archive failed" as const,
    description: `${pending.error ? `${pending.error} ` : ""}Conversations remain visible; some work may have stopped. Choose Archive again to retry, or dismiss to keep these threads as they are.`,
  };
}

/** Restore a cascaded archive through its exact historical cohort, never through lineage. */
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

export type ThreadArchiveFamily = Extract<
  Awaited<ReturnType<ReturnType<typeof createThreadEnvironmentAtoms>["loadArchiveFamily"]["run"]>>,
  { _tag: "Success" }
>["value"];

/** Render the shared family decision for native alerts. */
export function resolveThreadArchiveFamily(family: ThreadArchiveFamily) {
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

export const THREAD_ARCHIVE_CONSULTATION_BUSY_MESSAGE =
  "This agent is busy right now. Open its conversation, or stop active threads and archive.";
export const THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE =
  "This agent can't be asked about this work. Review the listed threads, or stop active threads and archive.";

export function threadArchiveConsultationUnavailableReason(
  target: ThreadArchiveConsultationTarget,
) {
  if (target.unavailableReason === "busy") return THREAD_ARCHIVE_CONSULTATION_BUSY_MESSAGE;
  if (
    target.unavailableReason === "unavailable" ||
    target.work.length === 0 ||
    target.work.some((work) => work.threadId === target.ownerThreadId)
  )
    return THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE;
  return null;
}

function buildThreadArchiveQuestion(input: {
  readonly familyRef: ScopedThreadRef;
  readonly family: { readonly threads: readonly Pick<EnvironmentThreadShell, "id" | "title">[] };
  readonly target: ThreadArchiveConsultationTarget;
}) {
  const { familyRef, family, target } = input;
  const titles = new Map(family.threads.map((thread) => [thread.id, thread.title]));
  return [
    "I'm deciding whether to archive this thread family. Please check the work below that you own.",
    `Environment: ${familyRef.environmentId}`,
    `Family root: ${formatThreadLink(familyRef, titles.get(familyRef.threadId) || "Archive family")}`,
    `Your thread: ${formatThreadLink({ environmentId: familyRef.environmentId, threadId: target.ownerThreadId }, target.ownerTitle)}`,
    ...target.work.map((work) =>
      [
        `- ${formatThreadLink({ environmentId: familyRef.environmentId, threadId: work.threadId }, titles.get(work.threadId) || "Untitled thread")}`,
        ...(work.taskId === undefined ? [] : [`task: ${work.taskId}`]),
        ...(work.runId === undefined ? [] : [`run: ${work.runId}`]),
        ...(work.attemptId === undefined ? [] : [`attempt: ${work.attemptId}`]),
      ].join("; "),
    ),
    "For each item, reply with whether it is finished and whether any result is still outstanding. You may use your existing task or recovery tools to complete or cancel this listed work if that is the right call. Do not archive this family or stop any other work; this question is not permission for either. I will review the family again before deciding whether to archive it.",
  ].join("\n");
}

/** Refresh server-owned execution mapping immediately before each explicit paid question. */
export async function consultThreadArchiveAgent(input: {
  readonly familyRef: ScopedThreadRef;
  readonly ownerThreadId: ThreadId;
  readonly inspect: () => Promise<{
    readonly threads: readonly EnvironmentThreadShell[];
    readonly consultationTargets?: readonly ThreadArchiveConsultationTarget[] | undefined;
  }>;
  readonly readOwner: (ref: ScopedThreadRef) => EnvironmentThreadShell | null;
  readonly randomId: () => string;
  readonly send: (input: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: StartThreadTurnInput;
  }) => Promise<void>;
}) {
  const family = await input.inspect();
  const target = family.consultationTargets?.find(
    (candidate) => candidate.ownerThreadId === input.ownerThreadId,
  );
  if (!target) return THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE;
  const reason = threadArchiveConsultationUnavailableReason(target);
  if (reason) return reason;
  const ref = { environmentId: input.familyRef.environmentId, threadId: target.ownerThreadId };
  const owner = input.readOwner(ref);
  if (!owner || owner.archivedAt !== null || owner.deletedAt !== null)
    return THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE;
  // The existing message command retains these IDs for socket-loss retries. Another Ask gets new IDs.
  await input.send({
    environmentId: ref.environmentId,
    input: {
      threadId: ref.threadId,
      commandId: CommandId.make(input.randomId()),
      message: {
        messageId: MessageId.make(input.randomId()),
        role: "user",
        text: buildThreadArchiveQuestion({ familyRef: input.familyRef, family, target }),
        attachments: [],
      },
      runtimeMode: owner.runtimeMode,
      interactionMode: owner.interactionMode,
      dispatchMode: "queue",
    },
  });
  return null;
}
