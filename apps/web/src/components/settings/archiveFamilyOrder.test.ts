import { describe, expect, it } from "vite-plus/test";
import {
  createArchivedThreadRestoreTarget,
  groupArchivedThreadFamilies,
} from "./archiveFamilyOrder";

describe("archived family restore target", () => {
  const owner = {
    id: "owner",
    archivedAt: "2026-10-07T00:00:00.000Z",
    deletedAt: null,
    archivedWith: { threadId: "owner", commandId: "family" },
  };
  const child = { ...owner, id: "child", environmentId: "environment-a" };
  type RestoreOwner = Omit<typeof owner, "archivedAt" | "deletedAt"> & {
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
  };
  const snapshots = (threads: readonly RestoreOwner[], environmentId = child.environmentId) => [
    { environmentId, snapshot: { threads } },
  ];

  it("restores the present living archived owner for a matching cohort", () => {
    const restoreTarget = createArchivedThreadRestoreTarget(snapshots([owner]));
    expect(restoreTarget(child)).toBe(owner.id);
    expect(restoreTarget({ ...owner, environmentId: child.environmentId })).toBe(owner.id);
    expect(restoreTarget({ ...child, archivedWith: undefined })).toBe(child.id);
  });

  it.each([
    { reason: "missing", threads: [] },
    { reason: "deleted", threads: [{ ...owner, deletedAt: owner.archivedAt }] },
    { reason: "unarchived", threads: [{ ...owner, archivedAt: null }] },
    {
      reason: "different cohort",
      threads: [{ ...owner, archivedWith: { ...owner.archivedWith, commandId: "other-cohort" } }],
    },
  ])("restores the selected child when its owner is $reason", ({ threads }) => {
    const restoreTarget = createArchivedThreadRestoreTarget(snapshots(threads));
    expect(restoreTarget(child)).toBe(child.id);
  });

  it("keeps same-id owners separate across environments and refreshes targets with snapshots", () => {
    const otherEnvironment = "environment-b";
    const restoreTarget = createArchivedThreadRestoreTarget([
      ...snapshots([{ ...owner, deletedAt: owner.archivedAt }]),
      ...snapshots([owner], otherEnvironment),
    ]);
    expect(restoreTarget(child)).toBe(child.id);
    expect(restoreTarget({ ...child, environmentId: otherEnvironment })).toBe(owner.id);
    expect(createArchivedThreadRestoreTarget(snapshots([owner]))(child)).toBe(owner.id);
    expect(createArchivedThreadRestoreTarget(snapshots([]))(child)).toBe(child.id);
  });

  it("does not rescan archived owners for repeated row labels and restore actions", () => {
    let idReads = 0;
    const threads = Array.from({ length: 2_000 }, (_, index) => ({
      ...owner,
      get id() {
        idReads += 1;
        return `owner-${index}`;
      },
      archivedWith: { threadId: `owner-${index}`, commandId: "family" },
    }));
    const restoreTarget = createArchivedThreadRestoreTarget(snapshots(threads));
    for (let index = 0; index < threads.length; index += 1) {
      const target = {
        ...child,
        archivedWith: { threadId: `owner-${index}`, commandId: "family" },
      };
      for (let read = 0; read < 3; read += 1) expect(restoreTarget(target)).toBe(`owner-${index}`);
    }
    expect(idReads).toBeLessThanOrEqual(threads.length * 4);
  });
});

describe("archived family ordering", () => {
  it("keeps each cohort together while retaining root and child ordering", () => {
    const owner = { id: "owner", archivedWith: { threadId: "owner", commandId: "family" } };
    const child = { id: "child", archivedWith: owner.archivedWith };
    const nestedChild = { id: "nested-child", archivedWith: owner.archivedWith };
    const independent = { id: "independent", archivedWith: null };
    const olderOwner = {
      id: "older-owner",
      archivedWith: { threadId: "older-owner", commandId: "older-family" },
    };
    const olderChild = { id: "older-child", archivedWith: olderOwner.archivedWith };
    const threads = [child, independent, olderChild, owner, nestedChild, olderOwner];
    expect(groupArchivedThreadFamilies(threads)).toEqual([
      independent,
      owner,
      child,
      nestedChild,
      olderOwner,
      olderChild,
    ]);
    expect(threads[0]).toBe(child);
  });

  it("leaves missing owners, unmatched cohorts and individually archived histories independent", () => {
    const owner = { id: "owner", archivedWith: { threadId: "owner", commandId: "new-family" } };
    const oldChild = {
      id: "old-child",
      archivedWith: { threadId: "owner", commandId: "old-family" },
    };
    const orphan = {
      id: "orphan",
      archivedWith: { threadId: "deleted-owner", commandId: "orphan-family" },
    };
    const independent = { id: "independent" };
    const threads = [oldChild, orphan, independent, owner];
    expect(groupArchivedThreadFamilies(threads)).toEqual(threads);
  });

  it("handles large independent archives without repeated history scans", () => {
    let idReads = 0;
    const threads = Array.from({ length: 2_000 }, (_, index) => ({
      get id() {
        idReads += 1;
        return `thread-${index}`;
      },
      archivedWith: { threadId: `thread-${index}`, commandId: `archive-${index}` },
    }));
    expect(groupArchivedThreadFamilies(threads)).toHaveLength(threads.length);
    expect(idReads).toBeLessThanOrEqual(threads.length * 5);
  });
});
