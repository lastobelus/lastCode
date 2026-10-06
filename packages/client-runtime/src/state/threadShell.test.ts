import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-v2");
const remoteEnvironmentId = EnvironmentId.make("remote-environment-v2");
const otherProjectId = ProjectId.make("other-project");

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [environmentId]) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  return {
    registry: AtomRegistry.make(),
    snapshotAtom,
    catalogValueAtom,
    threads: createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom }),
  };
}

describe("v2 thread shell lists", () => {
  it("updates creator placement from the shell stream while retaining environment and ordinary ownership", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const creator = ThreadId.make("creator:origin");
    const ordinary = {
      ...v2ThreadShell,
      createdBy: "agent" as const,
      creatorThreadId: creator,
      creatorGrouping: "grouped" as const,
    };
    const snapshot = { ...v2ShellSnapshot, threads: [ordinary] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    try {
      const before = registry.get(threads.navigationThreadShellsAtom)[0];
      expect(before?.creatorThreadId).toBe(creator);
      expect(before?.creatorGrouping).toBe("grouped");
      registry.set(
        snapshotAtom(environmentId),
        applyShellStreamEvent(snapshot, {
          kind: "thread.updated",
          location: "active",
          sequence: 1,
          thread: { ...ordinary, creatorGrouping: "independent" },
        }),
      );
      const after = registry.get(threads.navigationThreadShellsAtom)[0];
      expect(after?.creatorThreadId).toBe(creator);
      expect(after?.creatorGrouping).toBe("independent");
      expect(after?.environmentId).toBe(environmentId);
      expect(after?.lineage).toEqual(ordinary.lineage);
      expect(after?.source.createdBy).toBe("agent");
    } finally {
      dispose();
      registry.dispose();
    }
  });

  it("preserves ordered reference arrays when a middle thread changes", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: ["a", "b", "c"].map((id) => ({ ...v2ThreadShell, id: ThreadId.make(id) })),
    };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.threadRefsAtom);
    const before = registry.get(threads.threadRefsAtom);
    registry.set(
      snapshotAtom(environmentId),
      applyShellStreamEvent(snapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: { ...snapshot.threads[1]!, title: "Updated" },
      }),
    );
    expect(registry.get(threads.threadRefsAtom)).toBe(before);
    dispose();
    registry.dispose();
  });

  it("keeps navigation stable on hidden subagent updates and retains user forks", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const root = v2ThreadShell;
    const child = {
      ...root,
      id: ThreadId.make("child"),
      lineage: {
        ...root.lineage,
        parentThreadId: root.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const fork = {
      ...child,
      id: ThreadId.make("fork"),
      lineage: { ...child.lineage, relationshipToParent: "fork" as const },
    };
    const snapshot = { ...v2ShellSnapshot, threads: [root, child, fork] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    const before = registry.get(threads.navigationThreadShellsAtom);
    expect(before.map((thread) => thread.id)).toEqual([root.id, fork.id]);
    registry.set(snapshotAtom(environmentId), {
      ...snapshot,
      threads: [root, { ...child, title: "Child streaming" }, fork],
    });
    expect(registry.get(threads.navigationThreadShellsAtom)).toBe(before);
    expect(registry.get(threads.threadShellsAtom)).toHaveLength(3);
    dispose();
    registry.dispose();
  });

  it("retains archived subagent cleanup recovery until the cleanup settles", () => {
    const { registry, threads, snapshotAtom } = makeHarness();
    const recovery = {
      ...v2ThreadShell,
      id: ThreadId.make("archived-cleanup"),
      archivedAt: v2ThreadShell.updatedAt,
      deletedAt: v2ThreadShell.updatedAt,
      lineage: {
        ...v2ThreadShell.lineage,
        parentThreadId: v2ThreadShell.id,
        relationshipToParent: "subagent" as const,
      },
      worktreeCleanup: {
        status: "deleting" as const,
        repositoryRoot: "/repo",
        worktreePath: "/repo-worktrees/recovery",
        startedAt: DateTime.formatIso(v2ThreadShell.updatedAt),
      },
    };
    let snapshot: OrchestrationV2ShellSnapshot = { ...v2ShellSnapshot, threads: [recovery] };
    registry.set(snapshotAtom(environmentId), snapshot);
    const dispose = registry.mount(threads.navigationThreadShellsAtom);
    try {
      expect(registry.get(threads.navigationThreadShellsAtom)).toMatchObject([
        { id: recovery.id, archivedAt: DateTime.formatIso(recovery.archivedAt) },
      ]);
      snapshot = applyShellStreamEvent(snapshot, {
        kind: "thread.updated",
        location: "active",
        sequence: 1,
        thread: {
          ...recovery,
          worktreeCleanup: {
            ...recovery.worktreeCleanup,
            status: "failed",
            failedAt: DateTime.formatIso(recovery.updatedAt),
            error: "worktree is busy",
          },
        },
      });
      registry.set(snapshotAtom(environmentId), snapshot);
      expect(registry.get(threads.navigationThreadShellsAtom)[0]?.worktreeCleanup?.status).toBe(
        "failed",
      );
      registry.set(snapshotAtom(environmentId), {
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({ ...thread, worktreeCleanup: null })),
      });
      expect(registry.get(threads.navigationThreadShellsAtom)).toEqual([]);
      expect(registry.get(threads.threadShellsAtom)[0]?.archivedAt).toBe(
        DateTime.formatIso(recovery.archivedAt),
      );
      registry.set(
        snapshotAtom(environmentId),
        applyShellStreamEvent(snapshot, {
          kind: "thread.removed",
          location: "active",
          sequence: 2,
          threadId: recovery.id,
        }),
      );
      expect(registry.get(threads.threadShellsAtom)).toEqual([]);
    } finally {
      dispose();
      registry.dispose();
    }
  });

  it("shares point and list values without retaining an atom for every listed thread", () => {
    const harness = makeHarness();
    const snapshot = {
      ...v2ShellSnapshot,
      threads: Array.from({ length: 200 }, (_, index) => ({
        ...v2ThreadShell,
        id: ThreadId.make(`thread-${index}`),
      })),
    };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const listAtom = harness.threads.threadShellsAtom;
    const projectListAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    const disposeProjectList = harness.registry.mount(projectListAtom);
    try {
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(200);
      expect(harness.registry.get(projectListAtom)).toEqual(before);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
      const firstAtom = harness.threads.threadShellAtom({
        environmentId,
        threadId: snapshot.threads[0]!.id,
      });
      expect(harness.registry.get(firstAtom)).toBe(before[0]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        snapshotSequence: 1,
        threads: snapshot.threads.map((thread, index) =>
          index === 199 ? { ...thread, title: "Updated last thread" } : thread,
        ),
      });
      const after = harness.registry.get(listAtom);
      expect(after[0]).toBe(before[0]);
      expect(after.at(-1)).not.toBe(before.at(-1));
      expect(after.at(-1)?.title).toBe("Updated last thread");
      expect(harness.registry.get(projectListAtom).at(-1)).toBe(after.at(-1));
      expect(harness.registry.get(firstAtom)).toBe(after[0]);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
    } finally {
      disposeProjectList();
      disposeList();
      harness.registry.dispose();
    }
  });

  it("preserves project memberships on updates and keeps the same thread separate per environment", () => {
    const harness = makeHarness([environmentId, remoteEnvironmentId]);
    const otherThread = {
      ...v2ThreadShell,
      id: ThreadId.make("other-thread"),
      projectId: otherProjectId,
    };
    const snapshot = { ...v2ShellSnapshot, threads: [v2ThreadShell, otherThread] };
    harness.registry.set(harness.snapshotAtom(environmentId), snapshot);
    const membershipAtom = harness.threads.environmentThreadRefsByProjectAtom(environmentId);
    const listAtom = harness.threads.threadShellsForProjectRefsAtom([
      { environmentId: remoteEnvironmentId, projectId: v2ThreadShell.projectId },
      { environmentId, projectId: v2ThreadShell.projectId },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    try {
      const membership = harness.registry.get(membershipAtom);
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(2);
      expect(before[0]).not.toBe(before[1]);
      expect(before.map((thread) => thread.environmentId)).toEqual([
        remoteEnvironmentId,
        environmentId,
      ]);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [v2ThreadShell, { ...otherThread, title: "Changed elsewhere" }],
      });
      expect(harness.registry.get(membershipAtom)).toBe(membership);
      expect(harness.registry.get(listAtom)).toBe(before);

      harness.registry.set(harness.snapshotAtom(environmentId), {
        ...snapshot,
        threads: [{ ...v2ThreadShell, projectId: otherProjectId }, otherThread],
      });
      expect(harness.registry.get(listAtom)).toEqual([before[0]]);
      harness.registry.set(harness.snapshotAtom(remoteEnvironmentId), {
        ...v2ShellSnapshot,
        threads: [],
      });
      expect(harness.registry.get(listAtom)).toEqual([]);
    } finally {
      disposeList();
      harness.registry.dispose();
    }
  });
});
