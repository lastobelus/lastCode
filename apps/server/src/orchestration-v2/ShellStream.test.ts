import { describe, expect, it } from "@effect/vitest";
import type {
  ApplicationStoredEvent,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  OrchestrationV2ShellStreamItem as ShellItemSchema,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  archivedShellStreamItemFromThreadShell,
  attachRelatedThreadShellItems,
  buildActiveShellSnapshot,
  coalesceShellApplicationEvents,
  coalesceStoredThreadEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shellStreamItemsFromResumeSnapshot,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
} from "./ShellStream.ts";
import { applyShellStreamEvent } from "../../../../packages/client-runtime/src/state/shellReducer.ts";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";

const encodeShellItem = Schema.encodeSync(ShellItemSchema);
const decodeShellItem = Schema.decodeSync(ShellItemSchema);

function project(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    aggregateKind: "project",
    aggregateId: id,
  } as ApplicationStoredEvent;
}

function thread(sequence: number, id: string): ApplicationStoredEvent {
  return {
    sequence,
    event: { threadId: id },
  } as ApplicationStoredEvent;
}

const emptyShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
} as OrchestrationV2ShellSnapshot;

describe("buildActiveShellSnapshot", () => {
  it("never duplicates archived rows into the regular shell", () => {
    const active = shellFixture({ archivedAt: null });
    const archived = shellFixture({
      id: ThreadId.make("thread-archived"),
      archivedAt: "2026-07-30T00:00:00.000Z" as never,
    });

    expect(
      buildActiveShellSnapshot({
        projects: [],
        threads: {
          schemaVersion: 1,
          snapshotSequence: 4,
          threads: [active],
          archivedThreads: [archived],
        },
        snapshotSequence: 7,
      }),
    ).toEqual({
      schemaVersion: 1,
      snapshotSequence: 7,
      projects: [],
      threads: [active],
      archivedThreads: [],
    });
  });
});

describe("coalesceShellApplicationEvents", () => {
  it("retains both native refresh targets without retaining the transcript payload", () => {
    expect(
      toShellApplicationEvent(
        storedThreadEvent(7, "parent", {
          type: "subagent.updated",
          payload: {
            origin: "provider_native",
            childThreadId: ThreadId.make("native-child"),
            transcript: "x".repeat(1024 * 1024),
          },
        }),
      ),
    ).toEqual({ ...thread(7, "parent"), relatedThreadId: "native-child" });
  });
  it.each([
    { origin: "app_owned", childThreadId: "app-child" },
    { origin: "provider_native", childThreadId: null },
    { origin: "provider_native", childThreadId: "parent" },
  ])("retains only the parent target for $origin / $childThreadId", (payload) => {
    expect(
      toShellApplicationEvent(
        storedThreadEvent(7, "parent", { type: "subagent.updated", payload }),
      ),
    ).toEqual(thread(7, "parent"));
  });
  it("coalesces native targets independently without losing newer child or parent events", () => {
    const native = (sequence: number) =>
      toShellApplicationEvent(
        storedThreadEvent(sequence, "parent", {
          type: "subagent.updated",
          payload: { origin: "provider_native", childThreadId: "native-child" },
        }),
      );
    expect(coalesceShellApplicationEvents([native(7), thread(8, "native-child")])).toEqual([
      thread(7, "parent"),
      thread(8, "native-child"),
    ]);
    expect(coalesceShellApplicationEvents([native(7), thread(8, "parent")])).toEqual([
      thread(7, "native-child"),
      thread(8, "parent"),
    ]);
    expect(coalesceShellApplicationEvents([native(7), native(8)])).toEqual([
      thread(8, "parent"),
      thread(8, "native-child"),
    ]);
    expect(coalesceShellApplicationEvents([thread(6, "native-child"), native(7)])).toEqual([
      thread(7, "parent"),
      thread(7, "native-child"),
    ]);
  });
  it("keeps the newest event per aggregate and preserves sequence order", () => {
    expect(
      coalesceShellApplicationEvents([
        thread(2, "thread-a"),
        project(3, "project-a"),
        thread(4, "thread-b"),
        thread(5, "thread-a"),
        project(6, "project-a"),
      ]).map((event) => event.sequence),
    ).toEqual([4, 5, 6]);
  });
});

describe("atomic native shell refresh", () => {
  const parentId = ThreadId.make("parent");
  const childId = ThreadId.make("native-child");
  const parent = {
    ...v2ThreadShell,
    id: parentId,
    updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
  };
  const child = {
    ...v2ThreadShell,
    id: childId,
    status: "running" as const,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
  };
  const sibling = { ...v2ThreadShell, id: ThreadId.make("unrelated") };
  const native = toShellApplicationEvent(
    storedThreadEvent(7, parentId, {
      type: "subagent.updated",
      payload: { origin: "provider_native", childThreadId: childId },
    }),
  );
  const refresh = (shells: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>) =>
    attachRelatedThreadShellItems(
      coalesceShellApplicationEvents([thread(6, childId), native]).map((stored) => {
        if ("aggregateKind" in stored) throw new Error("Expected thread refresh");
        return shellStreamItemFromThreadShell({
          stored,
          shell: shells.get(stored.event.threadId) ?? null,
        });
      }),
    );
  const initial: OrchestrationV2ShellSnapshot = {
    ...v2ShellSnapshot,
    threads: [
      { ...parent, updatedAt: v2ThreadShell.updatedAt },
      { ...child, status: "idle" as const },
      sibling,
    ],
  };
  it("applies both shells at one sequence while retaining unrelated rows and replay idempotence", () => {
    const items = refresh(
      new Map<ThreadId, OrchestrationV2ThreadShell>([
        [parentId, parent],
        [childId, child],
      ]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === "thread.updated" && items[0].thread.id).toBe(parentId);
    const decoded = items.map((item) => decodeShellItem(encodeShellItem(item)));
    const next = decoded.reduce((snapshot, item) => {
      if (item.kind === "snapshot" || item.kind === "synchronized")
        throw new Error("Expected delta");
      return applyShellStreamEvent(snapshot, item);
    }, initial);
    expect(next.threads).toEqual([parent, child, sibling]);
    expect(next.projects).toBe(initial.projects);
    expect(next.snapshotSequence).toBe(7);
    expect(items.reduce(applyShellStreamEvent, next)).toBe(next);
  });
  it.each([null, { ...child, archivedAt: v2ThreadShell.createdAt }])(
    "refreshes the parent and removes a missing or archived native child: %j",
    (unavailableChild) => {
      const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([[parentId, parent]]);
      if (unavailableChild) shells.set(childId, unavailableChild);
      const next = refresh(shells).reduce(applyShellStreamEvent, initial);
      expect(next.threads).toEqual([parent, sibling]);
      expect(next.snapshotSequence).toBe(7);
    },
  );
  it("removes an archived parent and still updates its stranded child atomically", () => {
    const items = refresh(
      new Map<ThreadId, OrchestrationV2ThreadShell>([
        [parentId, { ...parent, archivedAt: parent.createdAt }],
        [childId, child],
      ]),
    );
    expect(items[0]?.kind).toBe("thread.removed");
    const next = items.reduce(applyShellStreamEvent, initial);
    expect(next.threads).toEqual([child, sibling]);
    expect(next.snapshotSequence).toBe(7);
  });
});

function storedThreadEvent(
  sequence: number,
  threadId: string,
  event: Record<string, unknown> = {},
): OrchestrationV2StoredEvent {
  return { sequence, event: { threadId, ...event } } as OrchestrationV2StoredEvent;
}

function shellFixture(overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell {
  return { id: "thread-a", archivedAt: null, ...overrides } as OrchestrationV2ThreadShell;
}

describe("coalesceStoredThreadEvents", () => {
  it("keeps the newest stored event per thread and preserves sequence order", () => {
    expect(
      coalesceStoredThreadEvents([
        storedThreadEvent(2, "thread-a"),
        storedThreadEvent(3, "thread-b"),
        storedThreadEvent(5, "thread-a"),
      ]).map((stored) => stored.sequence),
    ).toEqual([3, 5]);
  });
});

describe("shellStreamItemFromThreadShell", () => {
  it("puts archived cleanup tombstones in active recovery without changing archivedAt", () => {
    const shell = shellFixture({
      archivedAt: "2026-07-30T00:00:00.000Z" as never,
      deletedAt: "2026-07-31T00:00:00.000Z" as never,
      worktreeCleanup: {
        status: "deleting",
        repositoryRoot: "/example/repository",
        worktreePath: "/example/worktree",
        startedAt: "2026-07-31T00:00:00.000Z",
      },
    });
    expect(
      shellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({ kind: "thread.updated", sequence: 4, location: "active", thread: shell });
  });
  it("emits an active thread update when the shell is not archived", () => {
    const shell = shellFixture({ archivedAt: null });
    expect(
      shellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({
      kind: "thread.updated",
      sequence: 4,
      location: "active",
      thread: shell,
    });
  });

  it("removes archived threads from the active-only shell", () => {
    const shell = shellFixture({ archivedAt: "2026-07-30T00:00:00.000Z" as never });
    expect(
      shellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({
      kind: "thread.removed",
      sequence: 4,
      location: "active",
      threadId: "thread-a",
    });
  });

  it("emits an active-shell removal when an archived thread is deleted", () => {
    expect(
      shellStreamItemFromThreadShell({
        stored: storedThreadEvent(6, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: "2026-07-30T00:00:00.000Z" },
        }),
        shell: null,
      }),
    ).toEqual({
      kind: "thread.removed",
      sequence: 6,
      location: "active",
      threadId: "thread-a",
    });
  });

  it("emits a removal from the active list for other missing shells", () => {
    expect(
      shellStreamItemFromThreadShell({
        stored: storedThreadEvent(6, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: null },
        }),
        shell: null,
      }),
    ).toEqual({
      kind: "thread.removed",
      sequence: 6,
      location: "active",
      threadId: "thread-a",
    });
  });
});

describe("archivedShellStreamItemFromThreadShell", () => {
  it("removes archived tombstones on deletion and on a coalesced cleanup failure", () => {
    const shell = shellFixture({
      archivedAt: "2026-07-30T00:00:00.000Z" as never,
      deletedAt: "2026-07-31T00:00:00.000Z" as never,
      worktreeCleanup: {
        status: "failed",
        repositoryRoot: "/example/repository",
        worktreePath: "/example/worktree",
        startedAt: "2026-07-31T00:00:00.000Z",
        failedAt: "2026-07-31T00:00:01.000Z",
        error: "Busy worktree",
      },
    });
    for (const type of ["thread.deleted", "thread.metadata-updated"]) {
      expect(
        archivedShellStreamItemFromThreadShell({
          stored: storedThreadEvent(4, "thread-a", { type, payload: shell }),
          shell,
        }),
      ).toEqual({ kind: "thread.removed", sequence: 4, threadId: "thread-a" });
    }
  });
  it("emits an update for an archived shell", () => {
    const shell = shellFixture({ archivedAt: "2026-07-30T00:00:00.000Z" as never });
    expect(
      archivedShellStreamItemFromThreadShell({ stored: storedThreadEvent(4, "thread-a"), shell }),
    ).toEqual({ kind: "thread.updated", sequence: 4, thread: shell });
  });

  it("ignores active threads that never touched the archive", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", { type: "thread.settled" }),
        shell: shellFixture({ archivedAt: null }),
      }),
    ).toBeNull();
  });

  it("emits a removal when a thread leaves the archive", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", { type: "thread.unarchived" }),
        shell: shellFixture({ archivedAt: null }),
      }),
    ).toEqual({ kind: "thread.removed", sequence: 4, threadId: "thread-a" });
  });

  it("emits a removal when an archived thread is deleted", () => {
    expect(
      archivedShellStreamItemFromThreadShell({
        stored: storedThreadEvent(4, "thread-a", {
          type: "thread.deleted",
          payload: { archivedAt: "2026-07-30T00:00:00.000Z" },
        }),
        shell: null,
      }),
    ).toEqual({ kind: "thread.removed", sequence: 4, threadId: "thread-a" });
  });
});

describe("shellStreamItemFromEnrichmentRefresh", () => {
  it("batches nearby completion roots onto one snapshot item", () => {
    expect(
      shellStreamItemFromEnrichmentRefresh({
        snapshot: emptyShellSnapshot,
        changes: [
          { workspaceRoot: "/workspace/a" },
          { workspaceRoot: "/workspace/b" },
          { workspaceRoot: "/workspace/a" },
        ],
      }),
    ).toEqual({
      kind: "snapshot",
      snapshot: emptyShellSnapshot,
      resolvedRepositoryIdentityRoots: ["/workspace/a", "/workspace/b"],
    });
  });
});

describe("shellStreamItemsFromInitialSnapshot", () => {
  it("keeps thread rows out of the metadata-only enrichment frame", () => {
    const snapshot = {
      ...emptyShellSnapshot,
      projects: [
        { id: "project-a", workspaceRoot: "/workspace/a" },
        { id: "project-b", workspaceRoot: "/workspace/b" },
      ],
      threads: [shellFixture({})],
      archivedThreads: [shellFixture({ id: ThreadId.make("thread-archived"), archivedAt: null })],
    } as unknown as OrchestrationV2ShellSnapshot;

    const items = shellStreamItemsFromInitialSnapshot({
      snapshot,
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });

    expect(items[0]).toEqual({ kind: "snapshot", snapshot });
    expect(items[1]).toMatchObject({
      kind: "snapshot",
      snapshot: {
        projects: [{ id: "project-a", workspaceRoot: "/workspace/a" }],
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });
    expect(JSON.stringify(items[1]).length).toBeLessThan(JSON.stringify(items[0]).length);
  });

  it("emits unmarked authoritative then same-sequence marked enrichment when roots resolved", () => {
    const snapshot = {
      ...emptyShellSnapshot,
      snapshotSequence: 7,
    } as OrchestrationV2ShellSnapshot;

    expect(
      shellStreamItemsFromInitialSnapshot({
        snapshot,
        resolvedRepositoryIdentityRoots: ["/workspace/a", "/workspace/a"],
      }),
    ).toEqual([
      { kind: "snapshot", snapshot },
      {
        kind: "snapshot",
        snapshot,
        resolvedRepositoryIdentityRoots: ["/workspace/a"],
      },
    ]);
  });

  it("emits only the unmarked authoritative snapshot when no roots resolved", () => {
    expect(
      shellStreamItemsFromInitialSnapshot({
        snapshot: emptyShellSnapshot,
        resolvedRepositoryIdentityRoots: [],
      }),
    ).toEqual([{ kind: "snapshot", snapshot: emptyShellSnapshot }]);
  });
});

describe("shellStreamItemsFromResumeSnapshot", () => {
  it("never repeats the authoritative shell snapshot", () => {
    expect(
      shellStreamItemsFromResumeSnapshot({
        snapshot: {
          ...emptyShellSnapshot,
          threads: [shellFixture({})],
        },
        resolvedRepositoryIdentityRoots: [],
      }),
    ).toEqual([]);
  });
});

describe("composeShellStreamWithEnrichment", () => {
  it.effect(
    "emits every initial item before enrichment even when enrichment is already ready",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 5,
        } as OrchestrationV2ShellSnapshot;
        const enrichmentSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 10,
        } as OrchestrationV2ShellSnapshot;

        const initialItems = shellStreamItemsFromInitialSnapshot({
          snapshot: initialSnapshot,
          resolvedRepositoryIdentityRoots: ["/workspace/a"],
        });
        // Enrichment stream is fully ready before the composed stream is pulled.
        const enrichment = Stream.make(
          shellStreamItemFromEnrichmentRefresh({
            snapshot: enrichmentSnapshot,
            changes: [{ workspaceRoot: "/workspace/b" }],
          }),
        );
        const tail = Stream.make(
          { kind: "synchronized" as const },
          {
            kind: "project.removed" as const,
            sequence: 6,
            projectId: "project-a",
          },
        );

        const items = Array.from(
          yield* composeShellStreamWithEnrichment({
            initial: Stream.fromIterable(initialItems),
            tail,
            enrichment,
          }).pipe(Stream.runCollect),
        );

        expect(items.slice(0, initialItems.length)).toEqual(initialItems);

        const enrichmentIndex = items.findIndex(
          (item) =>
            item.kind === "snapshot" &&
            "resolvedRepositoryIdentityRoots" in item &&
            item.resolvedRepositoryIdentityRoots?.includes("/workspace/b"),
        );
        expect(enrichmentIndex).toBeGreaterThanOrEqual(initialItems.length);

        for (let index = 0; index < initialItems.length; index++) {
          expect(items[index]).toEqual(initialItems[index]);
        }
      }),
  );

  it.effect("still interleaves enrichment with the post-prefix tail after initials drain", () =>
    Effect.gen(function* () {
      const items = Array.from(
        yield* composeShellStreamWithEnrichment({
          initial: Stream.make("initial-unmarked", "initial-marked"),
          tail: Stream.make("tail-a", "tail-b"),
          enrichment: Stream.make("enrichment"),
        }).pipe(Stream.runCollect),
      );

      expect(items.slice(0, 2)).toEqual(["initial-unmarked", "initial-marked"]);
      expect(items).toContain("enrichment");
      expect(items).toContain("tail-a");
      expect(items).toContain("tail-b");
      expect(items.indexOf("enrichment")).toBeGreaterThanOrEqual(2);
    }),
  );
});

describe("dedupeShellEnrichment", () => {
  const project = {
    id: ProjectId.make("project-a"),
    title: "A project",
    workspaceRoot: "/workspace/a",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  const initial = {
    kind: "snapshot" as const,
    snapshot: { ...emptyShellSnapshot, projects: [project] },
  };
  const marked = { ...initial, resolvedRepositoryIdentityRoots: [project.workspaceRoot] };

  it.effect(
    "keeps initial/resume resolution and real changes but drops sequence-only repeats",
    () =>
      Effect.gen(function* () {
        const repeated = {
          ...marked,
          snapshot: { ...marked.snapshot, snapshotSequence: 10, projects: [{ ...project }] },
        };
        const progressed = {
          ...repeated,
          resolvedRepositoryIdentityRoots: [project.workspaceRoot, "/workspace/b"],
        };
        const changed = {
          ...progressed,
          snapshot: { ...progressed.snapshot, projects: [{ ...project, title: "Renamed" }] },
        };
        const items = yield* Stream.make(
          initial,
          marked,
          repeated,
          progressed,
          changed,
          changed,
        ).pipe(dedupeShellEnrichment, Stream.runCollect);
        expect(items).toEqual([initial, marked, progressed, changed]);
        const resumed = Stream.make(marked, repeated).pipe(dedupeShellEnrichment);
        expect(yield* Stream.runCollect(resumed)).toEqual([marked]);
        expect(yield* Stream.runCollect(resumed)).toEqual([marked]);
      }),
  );

  it.effect("keeps authoritative snapshots and invalidates metadata after project deltas", () =>
    Effect.gen(function* () {
      const removed = { kind: "project.removed" as const, projectId: project.id, sequence: 2 };
      const updated = { kind: "project.updated" as const, project, sequence: 3 };
      const withThreads = {
        ...marked,
        snapshot: { ...marked.snapshot, threads: [shellFixture({})] },
      };
      const values = [
        initial,
        initial,
        marked,
        removed,
        marked,
        updated,
        marked,
        withThreads,
        withThreads,
      ];
      expect(
        yield* Stream.fromIterable(values).pipe(dedupeShellEnrichment, Stream.runCollect),
      ).toEqual(values);
    }),
  );

  it.effect(
    "deduplicates across thread deltas without dropping those deltas or identity clears",
    () =>
      Effect.gen(function* () {
        const delta = {
          kind: "thread.removed" as const,
          threadId: ThreadId.make("thread-a"),
          location: "active" as const,
          sequence: 2,
        };
        const resolved = {
          ...marked,
          snapshot: {
            ...marked.snapshot,
            projects: [
              {
                ...project,
                repositoryIdentity: {
                  canonicalKey: "github.com/test/repo",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "https://github.com/test/repo.git",
                  },
                },
              },
            ],
          },
        };
        expect(
          yield* Stream.make(marked, delta, marked, resolved, marked).pipe(
            dedupeShellEnrichment,
            Stream.runCollect,
          ),
        ).toEqual([marked, delta, resolved, marked]);
      }),
  );
});

describe("skipUnchangedThreadShells", () => {
  const at = (ms: number) => DateTime.makeUnsafe(Date.parse("2026-10-01T00:00:00.000Z") + ms);
  const shell = (
    id: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ): OrchestrationV2ThreadShell => ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-a"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    branch: null,
    status: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestUserMessageAt: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  });
  type Step =
    | { readonly advanceMs: number }
    | Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" | "synchronized" }>;
  const updated = (sequence: number, thread: OrchestrationV2ThreadShell): Step => ({
    kind: "thread.updated",
    sequence,
    location: "active",
    thread,
  });
  const run = (steps: ReadonlyArray<Step>) =>
    Stream.fromIterable(steps).pipe(
      Stream.mapEffect((step) =>
        "advanceMs" in step
          ? TestClock.adjust(Duration.millis(step.advanceMs)).pipe(Effect.as(null))
          : Effect.succeed(step),
      ),
      Stream.filter((item) => item !== null),
      skipUnchangedThreadShells,
      Stream.runCollect,
      Effect.map((items) => Array.from(items, (item) => ("sequence" in item ? item.sequence : -1))),
    );

  it.effect("drops shells that only moved updatedAt, and resends them after a while", () =>
    Effect.gen(function* () {
      const sent = yield* run([
        updated(1, shell("a")),
        updated(2, shell("a", { updatedAt: at(100) })),
        updated(3, shell("a", { updatedAt: at(200), itemCount: 2, visibleItemCount: 2 })),
        updated(4, shell("a", { updatedAt: at(300), itemCount: 2, visibleItemCount: 2 })),
        updated(5, shell("b")),
        // The resend window is 5 s.
        { advanceMs: 5_000 },
        updated(6, shell("a", { updatedAt: at(5_300), itemCount: 2, visibleItemCount: 2 })),
      ]);
      expect(sent).toEqual([1, 3, 5, 6]);
    }),
  );

  it.effect("sends the next update after a removal", () =>
    Effect.gen(function* () {
      const sent = yield* run([
        updated(1, shell("a")),
        { kind: "thread.removed", sequence: 2, location: "active", threadId: ThreadId.make("a") },
        updated(3, shell("a")),
      ]);
      expect(sent).toEqual([1, 2, 3]);
    }),
  );
  it.effect(
    "forwards related changes despite an unchanged parent and updates the child cache",
    () =>
      Effect.gen(function* () {
        const sent = yield* run([
          updated(1, shell("parent")),
          updated(2, shell("child")),
          {
            kind: "thread.updated",
            sequence: 3,
            location: "active",
            thread: shell("parent"),
            relatedThreads: [shell("child", { status: "idle" })],
          },
          updated(4, shell("child", { status: "idle" })),
          {
            kind: "thread.updated",
            sequence: 5,
            location: "active",
            thread: shell("parent"),
            relatedRemovedThreadIds: [ThreadId.make("child")],
          },
          updated(6, shell("child", { status: "idle" })),
        ]);
        expect(sent).toEqual([1, 2, 3, 5, 6]);
      }),
  );
});
