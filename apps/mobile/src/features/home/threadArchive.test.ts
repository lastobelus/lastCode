import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { resolveThreadArchiveFamily, threadCanArchive } from "./threadArchive";
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
