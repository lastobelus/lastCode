import type {
  LinkedArchiveOperation,
  LinkedArchivePreview,
  LinkedArchiveSelection,
  PeerArchiveUnavailable,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export const LINKED_ARCHIVE_STATUS_LABEL = msg("Linked archive status");
export const LINKED_ARCHIVE_NO_ACTIVITY = msg("No linked machines to check for this thread");
export const LINKED_ARCHIVE_RETRY_ARCHIVE = msg("Retry archive");
export const LINKED_ARCHIVE_RETRY_RESTORE = msg("Retry restore");
export const ARCHIVE_TYPED_IN_LABEL = msg(
  "Also archive threads you’ve written in, and their child threads",
);
export const linkedArchiveRetryMessage = msg(
  "If a linked machine hasn’t finished, check or retry it in Archived threads → Linked archive status.",
);

const reasons = {
  offline: msg("Offline", { $context: "connection status" }),
  denied: msg("Access denied"),
  unsupported: msg("Update this machine to review its threads"),
  unlinked: msg("No longer linked"),
  changed: msg("Link now reaches a different machine"),
  selection_changed: msg("Archive choices changed"),
};

const statuses = {
  pending: msg("Pending", { $context: "linked archive status" }),
  blocked: msg("Blocked", { $context: "linked archive status" }),
  review: msg("Needs review", { $context: "linked archive status" }),
  committed: msg("Archived"),
  restored: msg("Restored"),
};

export function linkedArchiveWarning(
  machine: {
    readonly status: keyof typeof statuses;
    readonly reason?: PeerArchiveUnavailable["reason"] | undefined;
  },
  resolve: MFunctionType,
) {
  const status = resolve(statuses[machine.status]);
  return machine.reason === undefined ? status : `${status} · ${resolve(reasons[machine.reason])}`;
}

export function linkedArchiveSelection(
  peers: readonly LinkedArchivePreview[],
  includeTypedIn: boolean,
): LinkedArchiveSelection[] {
  return peers.map((peer) => {
    if (peer.status !== "ready") return peer;
    const { environmentId, label, inventory } = peer;
    const choices = inventory.archiveChoices;
    if (choices === undefined)
      return { environmentId, label, status: "blocked", reason: "unsupported" };
    return {
      environmentId,
      label,
      status: "ready",
      cohorts: includeTypedIn ? choices.includingTypedInCohorts : choices.defaultCohorts,
    };
  });
}

export function canIncludeLinkedTypedIn(peers: readonly LinkedArchivePreview[] | undefined) {
  return peers?.some((peer) => {
    if (peer.status !== "ready" || peer.inventory.archiveChoices === undefined) return false;
    const { defaultCohorts, includingTypedInCohorts } = peer.inventory.archiveChoices;
    const selected = new Set(defaultCohorts.flatMap(({ selectedThreadIds }) => selectedThreadIds));
    return includingTypedInCohorts.some(({ selectedThreadIds }) =>
      selectedThreadIds.some((threadId) => !selected.has(threadId)),
    );
  });
}

function buildRecovery(
  operation: LinkedArchiveOperation,
  preview: readonly LinkedArchivePreview[],
  resolve: MFunctionType,
) {
  const needingReview = new Set(
    operation.operation === "archive"
      ? operation.machines
          .filter(({ status }) => status === "review")
          .map(({ environmentId }) => environmentId)
      : [],
  );
  const reviewPreviews = preview.filter(({ environmentId }) => needingReview.has(environmentId));
  const reviewable = reviewPreviews.filter(
    (peer) => peer.status === "ready" && peer.inventory.archiveChoices !== undefined,
  );
  const readyForReview = new Set(reviewable.map(({ environmentId }) => environmentId));
  const canRetry = operation.machines.some(
    ({ status }) => status === "pending" || status === "blocked",
  );
  return {
    operation: operation.operation,
    label: [
      resolve(
        operation.operation === "archive"
          ? msg("Archive")
          : canRetry
            ? LINKED_ARCHIVE_RETRY_RESTORE
            : statuses.restored,
      ),
      DateTime.formatLocal(DateTime.makeUnsafe(operation.archivedAt), {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    ].join(" · "),
    sourceArchiveCommandId: operation.sourceArchiveCommandId,
    machines: operation.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label || machine.environmentId,
      status: linkedArchiveWarning(
        readyForReview.has(machine.environmentId) ? { status: machine.status } : machine,
        resolve,
      ),
    })),
    reviewPreviews,
    canRetry: canRetry || reviewable.length > 0,
    selection: (includeTypedIn: boolean) => linkedArchiveSelection(reviewable, includeTypedIn),
  };
}

export type LinkedArchiveRecovery = ReturnType<typeof buildRecovery>;

/** Previously reviewed cohorts stay on the server. Only machines asking for review get new consent. */
export function buildLinkedArchiveRecoveries(
  family: {
    readonly linkedArchiveOperations?: readonly LinkedArchiveOperation[] | undefined;
    readonly linkedArchivePreview?: readonly LinkedArchivePreview[] | undefined;
  },
  resolve: MFunctionType = mFallback,
) {
  return (family.linkedArchiveOperations ?? []).map((operation) =>
    buildRecovery(operation, family.linkedArchivePreview ?? [], resolve),
  );
}
