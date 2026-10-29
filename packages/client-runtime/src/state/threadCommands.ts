import type { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import {
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";

import { type EnvironmentRpcInput, request } from "../rpc/client.ts";
import { awaitThreadShell } from "./threadShellAvailability.ts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import * as DateTime from "effect/DateTime";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  mapAtomCommandResult,
} from "./runtime.ts";
import {
  type RetryThreadWorktreeCleanupInput,
  type AbandonThreadWorktreeCleanupInput,
  type SetThreadPersistenceInput,
  type UpsertThreadAnnotationInput,
  type ResolveThreadAnnotationInput,
  type ReopenThreadAnnotationInput,
  type InterruptThreadTurnInput,
  type RequestSubagentPromotionInput,
  type CancelSubagentPromotionInput,
  archiveThread,
  closeGuestShare,
  resolveGuestMessage,
  cancelQueuedRun,
  createThread,
  deleteThread,
  retryThreadWorktreeCleanup,
  abandonThreadWorktreeCleanup,
  setThreadPersistence,
  upsertThreadAnnotation,
  resolveThreadAnnotation,
  reopenThreadAnnotation,
  editQueuedRun,
  interruptThreadTurn,
  forkThreadFromRun,
  markThreadUnread,
  mergeThreadBack,
  requestSubagentPromotion,
  cancelSubagentPromotion,
  promoteQueuedRun,
  resumeThreadQueue,
  retryWorkspacePreparation,
  linkThreadPullRequest,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  setThreadAutoSettle,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
  visitThread,
  watchThreadPullRequest,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { presentThreadShell } from "./models.ts";

export type LoadEarlierThreadHistoryInput = {
  readonly threadId: ThreadId;
  readonly throughEntryId?: string;
  readonly workAnchorId?: string;
};

export type {
  RetryThreadWorktreeCleanupInput,
  AbandonThreadWorktreeCleanupInput,
  SetThreadPersistenceInput,
  UpsertThreadAnnotationInput,
  ResolveThreadAnnotationInput,
  ReopenThreadAnnotationInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const loadEarlierHistory = Effect.fn("ThreadCommands.loadEarlierHistory")(function* (
    input: LoadEarlierThreadHistoryInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    if (Option.isNone(controller)) {
      return {
        _tag: "noop",
      } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    return yield* controller.value.loadEarlier(
      supervisor.target.environmentId,
      input.threadId,
      input.throughEntryId,
      input.workAnchorId,
    );
  });

  // Runs whether or not the server accepted the interrupt, so a stale cached item still
  // settles when Stop had nothing to interrupt; the interrupt's own failure still surfaces.
  // The repair is detached: its lookups must not hold the thread's serial command key, and
  // closing the thread cancels the repair, not the Stop that triggered it.
  const interruptTurn = Effect.fn("ThreadCommands.interruptTurn")(function* (
    input: InterruptThreadTurnInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    return yield* interruptThreadTurn(input).pipe(
      Effect.ensuring(
        Option.match(controller, {
          onNone: () => Effect.void,
          onSome: (value) =>
            value
              .reconcilePendingWork(supervisor.target.environmentId, input.threadId)
              .pipe(Effect.forkDetach, Effect.asVoid),
        }),
      ),
    );
  });

  const commands = {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: createThread,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: deleteThread,
      scheduler,
      concurrency,
    }),
    closeGuestShare: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:close-guest-share",
      execute: closeGuestShare,
      scheduler,
      concurrency,
    }),
    resolveGuestMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resolve-guest-message",
      execute: resolveGuestMessage,
      scheduler,
      concurrency,
    }),
    retryWorktreeCleanup: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:retryWorktreeCleanup",
      execute: (input: RetryThreadWorktreeCleanupInput) => retryThreadWorktreeCleanup(input),
      scheduler,
      concurrency,
    }),
    abandonWorktreeCleanup: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:abandonWorktreeCleanup",
      execute: (input: AbandonThreadWorktreeCleanupInput) => abandonThreadWorktreeCleanup(input),
      scheduler,
      concurrency,
    }),
    setPersistence: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:setPersistence",
      execute: (input: SetThreadPersistenceInput) => setThreadPersistence(input),
      scheduler,
      concurrency,
    }),
    upsertAnnotation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:upsertAnnotation",
      execute: (input: UpsertThreadAnnotationInput) => upsertThreadAnnotation(input),
      scheduler,
      concurrency,
    }),
    resolveAnnotation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resolveAnnotation",
      execute: (input: ResolveThreadAnnotationInput) => resolveThreadAnnotation(input),
      scheduler,
      concurrency,
    }),
    reopenAnnotation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reopenAnnotation",
      execute: (input: ReopenThreadAnnotationInput) => reopenThreadAnnotation(input),
      scheduler,
      concurrency,
    }),
    recoverThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:recoverThread",
      tag: ORCHESTRATION_V2_WS_METHODS.recoverThread,
      scheduler,
      concurrency,
    }),
    repairThread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:repairThread",
      execute: (
        input: EnvironmentRpcInput<typeof ORCHESTRATION_V2_WS_METHODS.repairThread>,
        registry,
        environmentId,
      ) =>
        request(ORCHESTRATION_V2_WS_METHODS.repairThread, input).pipe(
          Effect.tap(({ threadId }) =>
            awaitThreadShell(registry, snapshotAtom(environmentId), threadId),
          ),
        ),
      scheduler,
      concurrency,
    }),
    resumeAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:resumeAction",
      tag: WS_METHODS.actionResumeResume,
      scheduler,
      concurrency,
    }),
    discardAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:discardAction",
      tag: WS_METHODS.actionResumeDiscard,
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: archiveThread,
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: unarchiveThread,
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: settleThread,
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: unsettleThread,
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: snoozeThread,
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: unsnoozeThread,
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: pinThread,
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: unpinThread,
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: reorderPinnedThread,
      scheduler,
      concurrency,
    }),
    setAutoSettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-auto-settle",
      execute: setThreadAutoSettle,
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: reorderActiveThread,
      scheduler,
      concurrency,
    }),
    visit: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:visit",
      execute: visitThread,
      scheduler,
      concurrency,
    }),
    markUnread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:mark-unread",
      execute: markThreadUnread,
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: updateThreadMetadata,
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: linkThreadPullRequest,
      scheduler,
      concurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: unlinkThreadPullRequest,
      scheduler,
      concurrency,
    }),
    watchPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:watch-pull-request",
      execute: watchThreadPullRequest,
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: setThreadRuntimeMode,
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: setThreadInteractionMode,
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: startThreadTurn,
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: interruptTurn,
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: respondToThreadApproval,
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: respondToThreadUserInput,
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: dismissThreadUserInput,
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: revertThreadCheckpoint,
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: stopThreadSession,
      scheduler,
      concurrency,
    }),
    forkFromRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-from-run",
      execute: forkThreadFromRun,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    requestSubagentPromotion: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:subagent:promote",
      execute: (input: RequestSubagentPromotionInput) => requestSubagentPromotion(input),
      scheduler,
      concurrency,
    }),
    cancelSubagentPromotion: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:subagent:cancel-promotion",
      execute: (input: CancelSubagentPromotionInput) => cancelSubagentPromotion(input),
      scheduler,
      concurrency,
    }),
    mergeBack: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:merge-back",
      execute: mergeThreadBack,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceThreadId, input.targetThreadId]),
      },
    }),
    resumeThreadQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resume-queue",
      execute: resumeThreadQueue,
      scheduler,
      concurrency,
    }),
    promoteQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote-queued-run",
      execute: promoteQueuedRun,
      scheduler,
      concurrency,
    }),
    cancelQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-queued-run",
      execute: cancelQueuedRun,
      scheduler,
      concurrency,
    }),
    retryWorkspacePreparation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:retry-workspace-preparation",
      execute: retryWorkspacePreparation,
      scheduler,
      concurrency,
    }),
    editQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:edit-queued-run",
      execute: editQueuedRun,
      scheduler,
      concurrency,
    }),
    loadEarlierHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:load-earlier-history",
      execute: loadEarlierHistory,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          `history:${JSON.stringify([environmentId, input.threadId])}`,
      },
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
  // Inspection may reconcile provider-proven stale activity, so use the write guard.
  const archiveFamily = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:commands:thread:archive-family",
    tag: ORCHESTRATION_V2_WS_METHODS.getThreadArchiveFamily,
    scheduler,
    concurrency,
  });
  const optimistic = createOptimisticThreadLifecycle(snapshotAtom);
  return {
    loadArchiveFamily: {
      ...archiveFamily,
      run: async (...[registry, target]: Parameters<typeof archiveFamily.run>) =>
        mapAtomCommandResult(await archiveFamily.run(registry, target), (family) => {
          const threads = family.threads.map((shell) =>
            presentThreadShell(target.environmentId, shell),
          );
          const byId = new Map(threads.map((thread) => [thread.id, thread]));
          const select = (ids: readonly ThreadId[]) =>
            ids.flatMap((id) => {
              const thread = byId.get(id);
              return thread === undefined ? [] : [thread];
            });
          return {
            ...family,
            threads,
            children: select(family.childThreadIds),
            activeChildren: select(family.activeChildThreadIds),
            activeThreads: select(family.activeThreadIds),
            unreadThreads: select(family.unreadThreadIds),
            promotableChildren: select(family.promotableChildThreadIds),
            protectedChildren: select(family.protectedChildThreadIds),
          };
        }),
    },
    ...commands,
    snapshotAtom: optimistic.snapshotAtom,
    settle: optimistic.wrap(commands.settle, (thread, _input, now, accepted) =>
      !accepted &&
      (thread.pendingRuntimeRequest !== null ||
        ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status))
        ? thread
        : {
            ...thread,
            pendingRuntimeRequest: null,
            settledOverride: "settled",
            settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
            unsettledAt: null,
            activeOrderKey: null,
            pinnedAt: null,
            pinOrderKey: null,
            snoozedAt: null,
            snoozedUntil: null,
          },
    ),
    unsettle: optimistic.wrap(commands.unsettle, (thread, input, now) => ({
      ...thread,
      settledOverride: input.reason === "user" ? "active" : null,
      settledAt: null,
      unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now,
    })),
    snooze: optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
      (!accepted &&
        (thread.pendingRuntimeRequest !== null ||
          ["preparing", "queued", "starting"].includes(thread.status))) ||
      !(Date.parse(input.snoozedUntil) > DateTime.toEpochMillis(now))
        ? thread
        : {
            ...thread,
            pendingRuntimeRequest: null,
            snoozedUntil: DateTime.makeUnsafe(input.snoozedUntil),
            snoozedAt: now,
          },
    ),
    unsnooze: optimistic.wrap(commands.unsnooze, (thread) => ({
      ...thread,
      snoozedUntil: null,
      snoozedAt: null,
    })),
    setAutoSettle: optimistic.wrap(commands.setAutoSettle, (thread, input, now) => ({
      ...thread,
      autoSettleDisabledAt: input.enabled ? null : (thread.autoSettleDisabledAt ?? now),
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
  };
}
