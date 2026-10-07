import { CommandId, EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import {
  resolveThreadArchiveFamily,
  threadCanArchive,
  threadUnarchiveTargetId,
} from "./threadArchive";
import { makeThreadShellFixture } from "../../test-fixtures";

function runtime(
  status: ThreadRuntimeSummary["status"],
  activeRunId: ThreadRuntimeSummary["activeRunId"],
): ThreadRuntimeSummary {
  return {
    status,
    activeRunId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "codex",
    lastError: null,
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
}

describe("threadCanArchive", () => {
  it("blocks provider-active work", () => {
    const activeRunId = RunId.make("run-live");
    expect(threadCanArchive(runtime("preparing", activeRunId))).toBe(false);
    expect(threadCanArchive(runtime("starting", activeRunId))).toBe(false);
    expect(threadCanArchive(runtime("running", activeRunId))).toBe(false);
  });

  it("only allows queued work when no provider run remains active", () => {
    const activeRunId = RunId.make("run-live");
    expect(threadCanArchive(runtime("queued", null))).toBe(true);
    expect(threadCanArchive(runtime("queued", activeRunId))).toBe(false);
  });

  it("allows post-provider waiting work despite a retained active run id", () => {
    const staleActiveRunId = RunId.make("run-finished");
    expect(threadCanArchive(runtime("waiting", null))).toBe(true);
    expect(threadCanArchive(runtime("waiting", staleActiveRunId))).toBe(true);
  });
});

describe("thread family archive confirmation", () => {
  const root = makeThreadShellFixture({ id: ThreadId.make("root"), title: "Parent" });
  const child = (id: string, parent = root.id) =>
    makeThreadShellFixture({
      id: ThreadId.make(id),
      title: id,
      environmentId: root.environmentId,
      lineage: { rootThreadId: root.id, parentThreadId: parent, relationshipToParent: "subagent" },
    });

  it("requires confirmation for recursive work and attention without pulling in other environments", () => {
    const first = child("first");
    const nested = { ...child("nested", first.id), hasPendingApprovals: true };
    const otherEnvironment = {
      ...child("remote"),
      environmentId: EnvironmentId.make("remote"),
      hasPendingUserInput: true,
    };
    const dormant = resolveThreadArchiveFamily([root, first, otherEnvironment], root);
    expect(dormant.requiresConfirmation).toBe(false);
    expect(dormant.children.map((thread) => thread.id)).toEqual([first.id]);
    const family = resolveThreadArchiveFamily([root, first, nested, otherEnvironment], root);
    expect(family.requiresConfirmation).toBe(true);
    expect(family.children.map((thread) => thread.id)).toEqual([first.id, nested.id]);
    expect(family.message).toContain("1 subagent is still working or needs your attention");
    expect(family.message).toContain("nested · Needs Approval");
    expect(family.message).toContain("Stopped work won't restart; promoted threads stay separate.");
  });

  it("restores a cascade through its archived owner while preserving individually archived children", () => {
    const archivedChild = { ...child("archived-child"), archivedAt: "2026-10-06T00:00:00.000Z" };
    const cohort = { threadId: root.id, commandId: CommandId.make("archive-family") };
    const archivedOwner = { ...root, archivedAt: archivedChild.archivedAt, archivedWith: cohort };
    expect(threadUnarchiveTargetId(archivedChild)).toBe(archivedChild.id);
    expect(
      threadUnarchiveTargetId(
        {
          ...archivedChild,
          archivedWith: cohort,
        },
        [archivedOwner],
      ),
    ).toBe(root.id);
    expect(threadUnarchiveTargetId({ ...archivedChild, archivedWith: null })).toBe(
      archivedChild.id,
    );
  });

  it("restores the surviving child when its archive owner is unavailable or belongs to another cohort", () => {
    const cohort = { threadId: root.id, commandId: CommandId.make("archive-family") };
    const archivedAt = "2026-10-06T00:00:00.000Z";
    const archivedChild = { ...child("survivor"), archivedAt, archivedWith: cohort };
    const archivedOwner = { ...root, archivedAt, archivedWith: cohort };
    const unavailableOwners = [
      [],
      [{ ...archivedOwner, deletedAt: archivedAt }],
      [{ ...archivedOwner, archivedAt: null }],
      [
        {
          ...archivedOwner,
          archivedWith: { ...cohort, commandId: CommandId.make("other-archive") },
        },
      ],
      [{ ...archivedOwner, archivedWith: null }],
      [{ ...archivedOwner, environmentId: EnvironmentId.make("other-environment") }],
    ];
    for (const owners of unavailableOwners) {
      expect(threadUnarchiveTargetId(archivedChild, owners)).toBe(archivedChild.id);
    }
  });

  it("allows keeping persistent descendants only under an independently runnable branch", () => {
    const first = child("first");
    const nested = { ...child("persistent", first.id), persistent: true };
    const family = resolveThreadArchiveFamily([root, first, nested], root);
    expect(family.requiresConfirmation).toBe(true);
    expect(family.canStopAndArchive).toBe(false);
    expect(family.canKeepSeparately).toBe(true);
    expect(family.message).toContain("Keep running separately preserves them");
    const native = { ...first, source: { ...first.source, creationSource: "provider" as const } };
    const nativeFamily = resolveThreadArchiveFamily([root, native, nested], root);
    expect(nativeFamily.canStopAndArchive).toBe(false);
    expect(nativeFamily.canKeepSeparately).toBe(false);
    expect(nativeFamily.message).toContain("Remove their persistent protection");
  });

  it("notes native subagents that will stop, and bounds the child preview", () => {
    const children = Array.from({ length: 5 }, (_, index) => ({
      ...child(`child-${index}`),
      hasPendingUserInput: true,
    }));
    const native = children[0]!;
    children[0] = { ...native, source: { ...native.source, creationSource: "provider" } };
    const family = resolveThreadArchiveFamily([root, ...children], root);
    expect(family.message).toContain("1 provider subagent cannot run on their own");
    expect(family.message).toContain("+2 more");
    expect(family.message).not.toContain("child-3");
  });
});
