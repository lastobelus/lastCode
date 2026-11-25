import {
  OrchestratorMcpFailure,
  type LinkedArchiveOperation,
  type LinkedArchivePreview,
  type LinkedArchiveSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadArchiveFamily,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import { captureLinkedArchiveOperations } from "../../../orchestration-v2/LastCodeLinkedArchiveOperations.ts";
import {
  captureLinkedArchivePreview,
  withLinkedArchivePreview,
} from "../../../orchestration-v2/LastCodeLinkedArchivePreview.ts";
import type { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { fencingLinkOrigin } from "../../linkOrigin.ts";
import { dispatchFailure, type Caller } from "../../threadAccess.ts";

type ArchiveCaller = Pick<Caller, "caller" | "scope">;

const defaultSelection = (peers: readonly LinkedArchivePreview[]): LinkedArchiveSelection[] =>
  peers.map((peer) => {
    if (peer.status !== "ready") return peer;
    const { environmentId, label, inventory } = peer;
    return inventory.archiveChoices === undefined
      ? { environmentId, label, status: "blocked", reason: "unsupported" }
      : {
          environmentId,
          label,
          status: "ready",
          cohorts: inventory.archiveChoices.defaultCohorts.map((cohort) =>
            cohort.childDisposition === "stop_and_archive"
              ? { ...cohort, childDisposition: "archive_if_idle" }
              : cohort,
          ),
        };
  });

const withRetryArgs = (
  threadId: ThreadId,
  operations: readonly LinkedArchiveOperation[],
  peers: readonly LinkedArchivePreview[] = [],
) =>
  operations.map((operation) => {
    const unresolved = operation.machines.filter(
      ({ status }) => status === "pending" || status === "blocked" || status === "review",
    );
    if (unresolved.length === 0) return operation;
    const archive = operation.operation === "archive";
    const reviewable = new Set(
      unresolved
        .filter(({ status }) => status === "review")
        .map(({ environmentId }) => environmentId),
    );
    const retryArgs = {
      threadId,
      action: archive ? ("archive" as const) : ("unarchive" as const),
      expectedLinkedArchiveCommandId: operation.sourceArchiveCommandId,
      ...(archive
        ? {
            linkedArchiveSelection: defaultSelection(
              peers.filter(({ environmentId }) => reviewable.has(environmentId)),
            ),
          }
        : {}),
    };
    return archive && operation.retryMayStopWork
      ? {
          ...operation,
          retryArgsAfterStopConsent: {
            ...retryArgs,
            childDisposition: "stop_and_archive" as const,
          },
        }
      : { ...operation, retryArgs };
  });

export const archiveFamilyToolResult = (
  threadId: ThreadId,
  family: OrchestrationV2ThreadArchiveFamily,
) => {
  const { linkedArchivePreview, linkedArchiveOperations } = family;
  return {
    ...Struct.omit(family, ["threads", "canPromote", "promotableChildThreadIds"]),
    ...(linkedArchivePreview !== undefined &&
    !linkedArchiveOperations?.some(({ operation }) => operation === "archive")
      ? { linkedArchiveSelection: defaultSelection(linkedArchivePreview) }
      : {}),
    ...(linkedArchiveOperations === undefined
      ? {}
      : {
          linkedArchiveOperations: withRetryArgs(
            threadId,
            linkedArchiveOperations,
            linkedArchivePreview,
          ),
        }),
    ...(linkedArchivePreview === undefined && linkedArchiveOperations === undefined
      ? {}
      : {
          linkedArchiveGuidance:
            "For a new archive, copy linkedArchiveSelection. For a retry, review machines marked review, then copy the chosen operation’s retryArgs. An empty selection reuses saved choices. Use retryArgsAfterStopConsent only with renewed consent to stop linked work. Use includingTypedInCohorts only with consent to archive typed-in work. Keep active cohorts at archive_if_idle unless the user consents to stop them.",
        }),
  };
};

export const capture = Effect.gen(function* () {
  const preview = yield* captureLinkedArchivePreview;
  const operations = yield* captureLinkedArchiveOperations;
  return {
    preview: (
      threadId: ThreadId,
      family: OrchestrationV2ThreadArchiveFamily,
      caller: ArchiveCaller,
    ) =>
      withLinkedArchivePreview(threadId, family, caller, preview).pipe(
        Effect.map((family) => archiveFamilyToolResult(threadId, family)),
      ),
    dispatch: Effect.fn("LastCodeLinkedArchiveTools.dispatch")(function* (
      command: OrchestrationV2Command,
      caller: ArchiveCaller,
      threads: Pick<ThreadManagementService["Service"], "dispatch">,
    ) {
      const local = threads.dispatch(command);
      const isArchive = command.type === "thread.archive";
      if (!isArchive && command.type !== "thread.unarchive") {
        const { sequence } = yield* local.pipe(Effect.mapError(dispatchFailure));
        return { sequence };
      }
      if (fencingLinkOrigin(caller) !== undefined) {
        if (
          command.expectedLinkedArchiveCommandId !== undefined ||
          (isArchive && command.linkedArchiveSelection !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This linked caller cannot archive or restore work on another environment.",
          });
        const { sequence } = yield* local.pipe(Effect.mapError(dispatchFailure));
        return { sequence };
      }
      const { sequence } = yield* operations
        .dispatch(command, local, { requireSavedStopConsent: true })
        .pipe(Effect.mapError(dispatchFailure));
      const linkedArchiveOperations = yield* operations
        .status(command.threadId)
        .pipe(Effect.orElseSucceed(() => []));
      return {
        sequence,
        ...(linkedArchiveOperations.length === 0
          ? {}
          : {
              linkedArchiveOperations: withRetryArgs(command.threadId, linkedArchiveOperations),
              linkedArchiveGuidance:
                "Report each affected machine by name and its status. Inspect the archive family for retry arguments and any stop consent required.",
            }),
      };
    }),
  };
});

export type LinkedArchiveTools = Effect.Success<typeof capture>;
