import { formatThreadLink } from "@t3tools/shared/threadLinks";
import {
  CommandId,
  MessageId,
  type LinkedArchivePreview,
  type ScopedThreadRef,
  type ThreadArchiveConsultationTarget,
  type ThreadArchiveTemporaryProjectSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { scopedProjectKey } from "../environment/scoped.ts";
import type { StartThreadTurnInput } from "../operations/commands.ts";
import type { createThreadEnvironmentAtoms } from "./threadCommands.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export const THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE = msg(
  "Update this environment's server before archiving thread families safely.",
);

const TEMPORARY_PROJECT_ARCHIVE_WARNING = msg(
  "These temporary projects and their thread histories will be deleted. Their folders and files will stay on disk. Unarchiving won't restore them.",
);

function selectedTemporaryProjects(
  preview: ThreadArchiveFamily["archivePreview"],
  includeTypedIn: boolean,
) {
  return preview?.temporaryProjects?.filter(
    ({ requiresTypedIn }) => includeTypedIn || !requiresTypedIn,
  );
}

export function archivePreviewSelection(
  family: Pick<ThreadArchiveFamily, "archivePreview" | "keptThreadIds">,
  includeTypedIn = false,
): {
  readonly expectedArchiveThreadIds?: readonly ThreadId[];
  readonly includeTypedInThreadIds?: readonly ThreadId[];
  readonly expectedTemporaryProjects?: readonly ThreadArchiveTemporaryProjectSelection[];
} {
  if (family.archivePreview === undefined) return {};
  const keptIds = new Set(keptArchivePreviewThreadIds(family, includeTypedIn));
  const projects = selectedTemporaryProjects(family.archivePreview, includeTypedIn);
  return {
    expectedArchiveThreadIds: family.archivePreview.threads
      .map(({ threadId }) => threadId)
      .filter((id) => !keptIds.has(id)),
    ...(includeTypedIn && family.archivePreview.typedInThreadIds.length > 0
      ? { includeTypedInThreadIds: family.archivePreview.typedInThreadIds }
      : {}),
    ...(projects === undefined
      ? {}
      : {
          expectedTemporaryProjects: projects.map(({ projectId, threadIds }) => ({
            projectId,
            threadIds,
          })),
        }),
  };
}

export function requiresThreadArchiveConfirmation(
  family: Pick<ThreadArchiveFamily, "requiresConfirmation" | "linkedArchivePreview">,
) {
  return (
    family.requiresConfirmation ||
    family.linkedArchivePreview?.some(
      (peer) => peer.status !== "ready" || peer.inventory.threads.length > 0,
    ) === true
  );
}

type ArchivePreviewFamily = {
  readonly archivePreview?: ThreadArchiveFamily["archivePreview"];
  readonly linkedArchivePreview?: ThreadArchiveFamily["linkedArchivePreview"];
  readonly keptThreadIds?: readonly ThreadId[];
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly environmentId?: EnvironmentThreadShell["environmentId"];
  }>;
};

function keptArchivePreviewThreadIds(
  family: Pick<ArchivePreviewFamily, "archivePreview" | "keptThreadIds">,
  includeTypedIn: boolean,
) {
  return includeTypedIn ? family.archivePreview?.keptWithTypedInThreadIds : family.keptThreadIds;
}

const linkedArchiveReasons = {
  offline: msg("Offline", { $context: "connection status" }),
  denied: msg("Access denied"),
  unsupported: msg("Update this machine to review its threads"),
  unlinked: msg("Machine is no longer linked"),
  changed: msg("A different machine answered"),
};

function archivePreviewThreadKey(
  environmentId: EnvironmentThreadShell["environmentId"] | undefined,
  threadId: ThreadId,
) {
  return JSON.stringify([environmentId, threadId]);
}

function buildLinkedArchiveSections(
  families: readonly ArchivePreviewFamily[],
  selectedKeys: ReadonlySet<string>,
  resolve: MFunctionType,
) {
  const machines = new Map<LinkedArchivePreview["environmentId"], LinkedArchivePreview[]>();
  for (const family of families) {
    for (const peer of family.linkedArchivePreview ?? []) {
      const previews = machines.get(peer.environmentId);
      if (previews) previews.push(peer);
      else machines.set(peer.environmentId, [peer]);
    }
  }
  return [...machines].map(([environmentId, peers]) => {
    const inventories = peers.flatMap((peer) => (peer.status === "ready" ? [peer.inventory] : []));
    const activeIds = new Set(inventories.flatMap(({ activeThreadIds }) => activeThreadIds));
    const unreadIds = new Set(inventories.flatMap(({ unreadThreadIds }) => unreadThreadIds));
    const protectedIds = new Set(
      inventories.flatMap(({ protectedThreadIds }) => protectedThreadIds),
    );
    const typedInIds = new Set(inventories.flatMap(({ typedInThreadIds }) => typedInThreadIds));
    const threads = new Map(
      inventories.flatMap(({ threads }) => threads.map((thread) => [thread.threadId, thread])),
    );
    const warnings = new Set(
      peers.flatMap((peer) =>
        peer.status === "ready"
          ? []
          : [
              [
                resolve(
                  peer.status === "pending"
                    ? msg("Pending", { $context: "linked archive status" })
                    : msg("Blocked", { $context: "linked archive status" }),
                ),
                resolve(linkedArchiveReasons[peer.reason]),
              ].join(" · "),
            ],
      ),
    );
    return {
      environmentId,
      label: peers[0]?.label || environmentId,
      warnings: [...warnings],
      threads: [...threads.values()].map((thread) => ({
        ...thread,
        title: thread.title || resolve(msg("Untitled thread")),
        label: [
          resolve(
            selectedKeys.has(archivePreviewThreadKey(environmentId, thread.threadId))
              ? msg("Archive")
              : msg("Keep open"),
          ),
          activeIds.has(thread.threadId)
            ? resolve(msg("Working", { $context: "thread status" }))
            : null,
          unreadIds.has(thread.threadId)
            ? resolve(msg("Unread", { $context: "thread status" }))
            : null,
          protectedIds.has(thread.threadId)
            ? resolve(msg("Persistent", { $context: "thread protected from archiving" }))
            : null,
          typedInIds.has(thread.threadId) ? resolve(msg("You wrote in this thread")) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    };
  });
}

/** One shared presentation for web and mobile; family membership and activity come from the server. */
export function buildThreadArchiveConfirmation<
  T extends Pick<EnvironmentThreadShell, "id" | "title" | "persistent"> &
    Partial<Pick<EnvironmentThreadShell, "projectId" | "environmentId">>,
>(
  family: {
    readonly threads: readonly T[];
    readonly children: readonly T[];
    readonly activeThreadIds: readonly string[];
    readonly unreadThreadIds: readonly string[];
    readonly protectedChildThreadIds: readonly string[];
    readonly canStopAndArchive: boolean;
    readonly archivePreview?: ThreadArchiveFamily["archivePreview"];
    readonly linkedArchivePreview?: ThreadArchiveFamily["linkedArchivePreview"];
    readonly keptThreadIds?: readonly ThreadId[];
    readonly bulkPreviews?: readonly ArchivePreviewFamily[];
    readonly bulkPreviewsIncludingTypedIn?: readonly ArchivePreviewFamily[];
  },
  resolve: MFunctionType = mFallback,
  includeTypedIn = false,
) {
  const typedInChoice = family.bulkPreviews ?? [family];
  const previews = includeTypedIn
    ? (family.bulkPreviewsIncludingTypedIn ?? typedInChoice)
    : typedInChoice;
  const hasPreview = previews.some(({ archivePreview }) => archivePreview !== undefined);
  const keyOf = (thread: T | ArchivePreviewFamily["threads"][number]) =>
    archivePreviewThreadKey(thread.environmentId, thread.id);
  const selectedThreads = previews.flatMap((preview) => {
    const kept = new Set(keptArchivePreviewThreadIds(preview, includeTypedIn));
    return preview.threads.filter(({ id }) => !kept.has(id));
  });
  const selectedKeys = new Set(selectedThreads.map(keyOf));
  const linkedMachines = buildLinkedArchiveSections(previews, selectedKeys, resolve);
  const showBulkSelection = family.bulkPreviews !== undefined && linkedMachines.length > 0;
  const previewKeys = new Set(
    hasPreview || showBulkSelection ? previews.flatMap(({ threads }) => threads.map(keyOf)) : [],
  );
  const archivesOnLinkedMachine = linkedMachines.some(({ environmentId }) =>
    selectedThreads.some((thread) => thread.environmentId === environmentId),
  );
  const keep = (thread: T) => previewKeys.has(keyOf(thread)) && !selectedKeys.has(keyOf(thread));
  const inScope = (thread: T) => !hasPreview || previewKeys.has(keyOf(thread));
  const participants = family.threads.filter((thread) => inScope(thread) && !keep(thread));
  const activeIds = new Set(family.activeThreadIds);
  const unreadIds = new Set(family.unreadThreadIds);
  const activeCount = participants.filter(({ id }) => activeIds.has(id)).length;
  const unreadCount = participants.filter(({ id }) => unreadIds.has(id)).length;
  const active = activeCount > 0;
  const unread = unreadCount > 0;
  const onlyLinkedReview = linkedMachines.length > 0 && !hasPreview && !active && !unread;
  const protectedThreads = participants.filter((thread) => thread.persistent);
  const blocked = !family.canStopAndArchive || protectedThreads.length > 0;
  const canIncludeTypedIn = typedInChoice.some(
    ({ archivePreview }) => (archivePreview?.typedInThreadIds.length ?? 0) > 0,
  );
  const temporaryProjects = [
    ...new Map(
      previews.flatMap(({ archivePreview }) =>
        archivePreview === undefined
          ? []
          : (selectedTemporaryProjects(archivePreview, includeTypedIn) ?? []).map(
              ({ projectId, title }) => {
                const project = { environmentId: archivePreview.environmentId, projectId, title };
                return [scopedProjectKey(project), project] as const;
              },
            ),
      ),
    ).values(),
  ];
  const protectedTitle = protectedThreads[0]?.title;
  const summary = blocked
    ? protectedThreads.length === 1
      ? protectedTitle
        ? resolve(
            msg(
              "{title} is persistent and can't be archived. Remove persistent protection, then try again.",
              { title: protectedTitle },
            ),
          )
        : resolve(
            msg(
              "This thread is persistent and can't be archived. Remove persistent protection, then try again.",
            ),
          )
      : resolve(
          msg(
            "{count} threads are persistent and can't be archived. Remove persistent protection, then try again.",
            { count: protectedThreads.length },
          ),
        )
    : hasPreview
      ? resolve(
          msg(
            "Threads marked Archive will be archived. Any still working will stop, and their pending approvals and queued messages will be canceled.",
          ),
        )
      : active
        ? resolve(
            msg(
              "{count, plural, one {{count} thread is still working. Archiving stops it, cancels pending approvals and queued messages, and archives the whole family.} other {{count} threads are still working. Archiving stops them, cancels pending approvals and queued messages, and archives the whole family.}}",
              { count: activeCount },
            ),
          )
        : onlyLinkedReview
          ? null
          : resolve(
              msg(
                "{count, plural, one {{count} thread has replies you haven't read.} other {{count} threads have replies you haven't read.}} Archiving closes the whole family. Replies stay in archived history.",
                { count: unreadCount },
              ),
            );
  const preservesAllHistory = !blocked && temporaryProjects.length === 0;
  const description = [
    summary,
    preservesAllHistory && active && unread
      ? resolve(msg("Unread replies stay in archived history."))
      : null,
    linkedMachines.length > 0 && !archivesOnLinkedMachine
      ? resolve(msg("Threads on linked machines will stay open."))
      : null,
    preservesAllHistory
      ? resolve(msg("Unarchiving reopens history. Stopped work won't restart."))
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    blocked,
    active,
    canIncludeTypedIn,
    description,
    temporaryProjects,
    temporaryProjectsWarning:
      temporaryProjects.length > 0 ? resolve(TEMPORARY_PROJECT_ARCHIVE_WARNING) : null,
    linkedMachines,
    confirmLabel: active
      ? resolve(msg("Stop active threads & archive"))
      : hasPreview || onlyLinkedReview
        ? resolve(msg("Archive threads"))
        : resolve(msg("Archive unread threads")),
    disposition: active
      ? ("stop_and_archive" as const)
      : onlyLinkedReview
        ? ("archive_if_idle" as const)
        : ("archive_after_review" as const),
    threads: family.threads
      .filter(
        (thread) =>
          inScope(thread) &&
          (previewKeys.has(keyOf(thread)) ||
            (blocked ? thread.persistent : activeIds.has(thread.id) || unreadIds.has(thread.id))),
      )
      .map((thread) => ({
        thread,
        ...(previewKeys.has(keyOf(thread)) ? { showLocation: true } : {}),
        label: keep(thread)
          ? resolve(msg("Keep open"))
          : thread.persistent
            ? resolve(msg("Persistent", { $context: "thread protected from archiving" }))
            : [
                previewKeys.has(keyOf(thread)) ? resolve(msg("Archive")) : null,
                activeIds.has(thread.id)
                  ? resolve(msg("Working", { $context: "thread status" }))
                  : null,
                unreadIds.has(thread.id)
                  ? resolve(msg("Unread", { $context: "thread status" }))
                  : null,
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
export function presentThreadArchive(
  thread: Pick<EnvironmentThreadShell, "archivePending">,
  resolve: MFunctionType = mFallback,
) {
  const pending = thread.archivePending;
  if (!pending) return null;
  if (pending.status === "stopping")
    return {
      status: "archiving" as const,
      label: resolve(msg("Archiving…")),
      description: resolve(msg("Stopping provider work before archiving this thread family.")),
    };
  return {
    status: "archive-failed" as const,
    label: resolve(msg("Archive failed")),
    description: resolve(
      msg(
        "{errorPrefix}Conversations remain visible; some work may have stopped. Choose Archive again to retry, or dismiss to keep these threads as they are.",
        { errorPrefix: pending.error ? `${pending.error} ` : "" },
      ),
    ),
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
export function resolveThreadArchiveFamily(
  family: ThreadArchiveFamily,
  resolve: MFunctionType = mFallback,
  projectName: (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) => string = ({
    projectId,
  }) => projectId,
) {
  const confirmation = buildThreadArchiveConfirmation(family, resolve);
  const details = confirmation.threads.map(({ thread, label, showLocation }) =>
    [
      thread.title || resolve(msg("Untitled thread")),
      ...(showLocation ? [projectName(thread)] : []),
      label,
    ].join(" · "),
  );
  const machines = confirmation.linkedMachines.map(({ environmentId, label, warnings, threads }) =>
    [
      label,
      ...warnings,
      ...threads.map((thread) =>
        [
          thread.title,
          thread.projectTitle ?? projectName({ environmentId, projectId: thread.projectId }),
          thread.label,
        ].join(" · "),
      ),
      ...(!warnings.length && !threads.length ? [resolve(LINKED_ARCHIVE_EMPTY_MESSAGE)] : []),
    ].join("\n"),
  );
  return {
    ...family,
    confirmLabel: confirmation.confirmLabel,
    disposition: confirmation.disposition,
    blocked: confirmation.blocked,
    message: [
      confirmation.description,
      details.join("\n"),
      ...machines,
      confirmation.temporaryProjectsWarning,
      confirmation.temporaryProjects.map(({ title }) => title).join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export const LINKED_ARCHIVE_EMPTY_MESSAGE = msg("Nothing to review on this machine");

export const THREAD_ARCHIVE_CONSULTATION_BUSY_MESSAGE = msg(
  "This agent is busy right now. Open its conversation, or stop active threads and archive.",
);
export const THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE = msg(
  "This agent can't be asked about this work. Review the listed threads, or stop active threads and archive.",
);

export function threadArchiveConsultationUnavailableReason(
  target: ThreadArchiveConsultationTarget,
  resolve: MFunctionType = mFallback,
) {
  if (target.unavailableReason === "busy") return resolve(THREAD_ARCHIVE_CONSULTATION_BUSY_MESSAGE);
  if (
    target.unavailableReason === "unavailable" ||
    target.work.length === 0 ||
    target.work.some((work) => work.threadId === target.ownerThreadId)
  )
    return resolve(THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE);
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
export async function consultThreadArchiveAgent(
  input: {
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
  },
  resolve: MFunctionType = mFallback,
) {
  const family = await input.inspect();
  const target = family.consultationTargets?.find(
    (candidate) => candidate.ownerThreadId === input.ownerThreadId,
  );
  if (!target) return resolve(THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE);
  const reason = threadArchiveConsultationUnavailableReason(target, resolve);
  if (reason !== null) return reason;
  const ref = { environmentId: input.familyRef.environmentId, threadId: target.ownerThreadId };
  const owner = input.readOwner(ref);
  if (!owner || owner.archivedAt !== null || owner.deletedAt !== null)
    return resolve(THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE);
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
