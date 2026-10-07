import { describe, expect, it } from "vite-plus/test";
import { groupArchivedThreadFamilies } from "./archiveFamilyOrder";

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
