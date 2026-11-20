import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeLastCodeArchivePlanner } from "./LastCodeArchivePlanner.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorThreadArchivingError,
} from "./Orchestrator.ts";

it.effect.each([
  "thread.archive",
  "thread.archive.complete",
  "thread.archive.fail",
  "thread.unarchive",
  "thread.delete",
] as const)("recollects a growing family before deciding %s under its expanded locks", (type) =>
  Effect.gen(function* () {
    const root = ThreadId.make("z-root");
    const child = ThreadId.make("a-arriving-child");
    let family = [root];
    const lockedSets: Array<ReadonlyArray<ThreadId>> = [];
    const held = new Set<string>();
    let decisions = 0;
    const commandId = CommandId.make(`recollect:${type}`);
    const command = {
      type,
      threadId: root,
      commandId,
      ...(type === "thread.archive.complete" || type === "thread.archive.fail"
        ? { requestId: CommandId.make("original-archive") }
        : {}),
      ...(type === "thread.archive.fail" ? { error: "Shutdown failed" } : {}),
    } as OrchestrationV2ServerCommand;
    // Every wrapped scope must unwind before expansion can reacquire it.
    const withHeld = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          assert.isFalse(held.has(name));
          held.add(name);
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            held.delete(name);
          }),
      );
    const unexpected = () => Effect.die("Only lock collection and dispatch are expected here");
    const planner = makeLastCodeArchivePlanner({
      reader: {
        store: {
          getShellSnapshot: unexpected,
          getThread: unexpected,
          getThreadShell: () => Effect.succeed(null),
          getThreadRecords: unexpected,
          getThreadProviderContext: unexpected,
          getThreadLatestAssistantMessageAt: unexpected,
          getOwnedThreadIds: unexpected,
          getGroupedCreatorThreadIds: () => Effect.succeed([]),
        },
        ownedThreadFamily: () => Effect.sync(() => family),
        archiveFamilyShells: unexpected,
        readArchiveFamilyShells: unexpected,
        readArchiveFamilyParentThreadId: () => Effect.succeed(null),
        archiveThreadPolicy: unexpected,
        liveSideChatIds: () => Effect.succeed([]),
      },
      locks: {
        withPersistenceLock: (effect) => withHeld("persistence", effect),
        withDeletionLock: (effect) => withHeld("deletion", effect),
        withThreadDispatchLocks: (ids, effect) =>
          Effect.suspend(() => {
            assert.isTrue(held.has("persistence"));
            const locked = [...ids];
            lockedSets.push(locked);
            // A child commits after the family read, before participant locks finish acquiring.
            family = [root, child];
            return withHeld("participants", effect);
          }),
      },
      admission: {
        admitNewExecution: (_command, kind, effect) => {
          assert.equal(kind, type === "thread.archive" ? "thread-archive" : "thread-delete");
          return withHeld("admission", effect);
        },
        refuseAboveDispatchModeLimit: unexpected,
      },
      mutation: {
        emit: () => unexpected,
        dispatchThreadMutation: unexpected,
        getProjectionWithPendingEvents: unexpected,
        markStoppedRun: unexpected,
        awaitsRestartContinuation: unexpected,
        disposeAllDelegatedCompletionCohorts: unexpected,
        releaseGuestAttachments: unexpected,
        clearPullRequestWatch: (link) => link,
      },
      errors: {
        OrchestratorDispatchError,
        OrchestratorProjectionError,
        OrchestratorThreadArchivingError,
      },
      commandThreadId: () => root,
    });
    assert.isTrue(planner.isFamilyCommand(command));
    if (!planner.isFamilyCommand(command)) return;
    yield* planner.dispatchFamily(command, () =>
      Effect.sync(() => {
        decisions++;
        assert.deepEqual(lockedSets.at(-1), [child, root]);
        assert.isTrue(held.has("persistence"));
        assert.isTrue(held.has("participants"));
        assert.equal(held.has("deletion"), type === "thread.delete");
        assert.equal(held.has("admission"), type === "thread.archive" || type === "thread.delete");
        return { sequence: 1, storedEvents: [] };
      }),
    );
    assert.deepEqual(lockedSets, [[root], [child, root]]);
    assert.equal(decisions, 1);
    assert.equal(held.size, 0);
  }),
);
