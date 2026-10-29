import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { makeThreadFixture } from "../../test-fixtures";
import {
  type RemovalDependencies,
  deleteLastCodeSidebarProject,
  requestLastCodeProjectRemoval,
} from "./lastcodeProjectRemoval";

type Toast = {
  type?: string;
  title: string;
  description?: string;
  actionProps?: { onClick: () => void };
};
const mocks = vi.hoisted(() => ({
  add: vi.fn<(toast: Toast) => string>(() => "warning"),
  close: vi.fn(),
  release: vi.fn(),
  getDraft: vi.fn(),
  clearDraft: vi.fn(),
  clearProject: vi.fn(),
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: Toast) => value,
  toastManager: { add: mocks.add, close: mocks.close },
}));
vi.mock("../../lib/composerDraftUploads", () => ({ releaseProjectDraftUploads: mocks.release }));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByProjectRef: mocks.getDraft,
      clearDraftThread: mocks.clearDraft,
      clearProjectDraftThreadId: mocks.clearProject,
    }),
  },
}));
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const env = EnvironmentId.make("remote:member"),
  projectId = ProjectId.make("same-id");
const member: SidebarProjectGroupMember = {
  id: projectId,
  environmentId: env,
  title: "Member",
  workspaceRoot: "/work/member",
  physicalProjectKey: "remote:member:project",
  environmentLabel: "Remote member",
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  createdAt: "2026-03-09T10:00:00Z",
  updatedAt: "2026-03-09T10:00:00Z",
  scripts: [],
};
const thread = (id: string, environmentId = env, persistent = false) =>
  makeThreadFixture({ id: ThreadId.make(id), environmentId, projectId, persistent });
function dependencies() {
  return {
    canOperate: vi.fn<RemovalDependencies["canOperate"]>(() => true),
    getApi: (() => ({
      dialogs: { confirm: vi.fn(async () => true) },
    })) as RemovalDependencies["getApi"],
    getThreads: vi.fn<RemovalDependencies["getThreads"]>(() => [thread("one")]),
    threadCount: 0,
    removeProject: vi.fn<RemovalDependencies["removeProject"]>(async () =>
      AsyncResult.success(undefined),
    ),
    waitForWarning: vi.fn(async () => {}),
  };
}
function warningAction() {
  const toast = mocks.add.mock.calls.find(([t]) => t.title === "Project is not empty")?.[0];
  expect(toast?.actionProps).toBeDefined();
  return toast!.actionProps!.onClick;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockImplementation(() => "warning");
  mocks.getDraft.mockReturnValue({ draftId: "draft-for-member" });
});
afterEach(() => vi.restoreAllMocks());
describe("project removal checkpoints", () => {
  it("blocks initial permission or persistence without opening a dialog", async () => {
    const d = dependencies(),
      confirm = vi.fn(async () => true);
    d.getApi = () => ({ dialogs: { confirm } });
    d.canOperate.mockReturnValue(false);
    await requestLastCodeProjectRemoval(member, d);
    expect(confirm).not.toHaveBeenCalled();
    d.canOperate.mockReturnValue(true);
    d.getThreads.mockReturnValue([thread("protected", env, true)]);
    await requestLastCodeProjectRemoval(member, d);
    expect(confirm).not.toHaveBeenCalled();
    expect(d.removeProject).not.toHaveBeenCalled();
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Persistent thread protected" }),
    );
  });
  it("ignores protected threads belonging to another member and tolerates no local API", async () => {
    const d = dependencies();
    d.getThreads.mockReturnValue([thread("protected-other", EnvironmentId.make("other"), true)]);
    await requestLastCodeProjectRemoval(member, d);
    expect(d.removeProject).toHaveBeenCalledWith(member);
    d.removeProject.mockClear();
    d.getApi = () => undefined;
    await requestLastCodeProjectRemoval(member, d);
    expect(d.removeProject).not.toHaveBeenCalled();
  });
  it("does not report or log an interrupted mutation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}),
      d = dependencies();
    d.removeProject.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    await requestLastCodeProjectRemoval(member, d);
    expect(log).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("cancels empty-member removal and preserves all cleanup", async () => {
    const d = dependencies();
    d.getApi = () => ({ dialogs: { confirm: vi.fn(async () => false) } });
    await requestLastCodeProjectRemoval(member, d);
    expect(d.removeProject).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("does not add a post-dialog persistence check", async () => {
    const d = dependencies();
    d.getApi = () => ({
      dialogs: {
        confirm: vi.fn(async () => {
          d.getThreads.mockReturnValue([thread("now-persistent", env, true)]);
          return true;
        }),
      },
    });
    await requestLastCodeProjectRemoval(member, d);
    expect(d.removeProject).toHaveBeenCalledWith(member);
    expect(d.getThreads).toHaveBeenCalledOnce();
  });
  it("waits for the warning transition then checks the exact member permission", async () => {
    const d = dependencies(),
      wait = deferred<void>(),
      checked = deferred<void>(),
      confirm = vi.fn(async () => true);
    d.threadCount = 1;
    d.getApi = () => ({ dialogs: { confirm } });
    d.waitForWarning.mockReturnValue(wait.promise);
    d.canOperate
      .mockImplementationOnce(() => true)
      .mockImplementation(() => {
        checked.resolve();
        return false;
      });
    await requestLastCodeProjectRemoval(member, d);
    warningAction()();
    expect(confirm).not.toHaveBeenCalled();
    expect(d.canOperate).toHaveBeenCalledOnce();
    wait.resolve();
    await checked.promise;
    expect(d.canOperate).toHaveBeenLastCalledWith(env);
    expect(confirm).not.toHaveBeenCalled();
    expect(d.removeProject).not.toHaveBeenCalled();
  });
  it("uses current exact-member thread count after the transition, preserving labels", async () => {
    const d = dependencies(),
      wait = deferred<void>(),
      called = deferred<string>(),
      choice = deferred<boolean>();
    d.threadCount = 1;
    d.waitForWarning.mockReturnValue(wait.promise);
    d.getApi = () => ({
      dialogs: {
        confirm: vi.fn((message: string) => {
          called.resolve(message);
          return choice.promise;
        }),
      },
    });
    await requestLastCodeProjectRemoval(member, d);
    warningAction()();
    d.getThreads.mockReturnValue([
      thread("a"),
      thread("b"),
      thread("other", EnvironmentId.make("other-environment")),
    ]);
    wait.resolve();
    const message = await called.promise;
    expect(message).toContain("delete its 2 threads?");
    expect(message).toContain("Path: /work/member");
    expect(message).toContain("Environment: Remote member");
    expect(mocks.close).toHaveBeenCalledWith("warning");
    choice.resolve(false);
    await choice.promise;
    expect(d.removeProject).not.toHaveBeenCalled();
  });
  it("logs empty-member mutation failure, but does not log nonempty returned failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}),
      d = dependencies();
    d.removeProject.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Rejected"))));
    await requestLastCodeProjectRemoval(member, d);
    expect(log).toHaveBeenCalledOnce();
    log.mockClear();
    const reported = deferred<void>();
    mocks.add.mockImplementation((t) => {
      if (t.type === "error") reported.resolve();
      return "warning";
    });
    d.threadCount = 1;
    await requestLastCodeProjectRemoval(member, d);
    warningAction()();
    await reported.promise;
    expect(log).not.toHaveBeenCalled();
    expect(mocks.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Failed to remove "Member"', description: "Rejected" }),
    );
  });
  it("logs and reports thrown nonempty removal errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}),
      d = dependencies(),
      reported = deferred<void>();
    d.threadCount = 1;
    d.removeProject.mockRejectedValue(new Error("Thrown"));
    mocks.add.mockImplementation((t) => {
      if (t.type === "error") reported.resolve();
      return "warning";
    });
    await requestLastCodeProjectRemoval(member, d);
    warningAction()();
    await reported.promise;
    expect(log).toHaveBeenCalledWith(
      "Failed to remove project",
      expect.objectContaining({ environmentId: env, projectId }),
    );
  });
});
describe("successful member cleanup", () => {
  it("cleans only exact-member uploads and drafts, after mutation success", async () => {
    const mutation = deferred<ReturnType<typeof AsyncResult.success<void>>>(),
      remove = vi.fn(() => mutation.promise);
    const running = deleteLastCodeSidebarProject(member, remove, [
      thread("target"),
      thread("same-id-other-env", EnvironmentId.make("other-environment")),
    ]);
    expect(remove).toHaveBeenCalledWith({ environmentId: env, input: { projectId, force: true } });
    expect(mocks.release).not.toHaveBeenCalled();
    mutation.resolve(AsyncResult.success(undefined));
    await running;
    const projectRef = { environmentId: env, projectId };
    expect(mocks.release).toHaveBeenCalledWith(projectRef, [
      { environmentId: env, threadId: "target" },
    ]);
    expect(mocks.getDraft).toHaveBeenCalledWith(projectRef);
    expect(mocks.clearDraft).toHaveBeenCalledWith("draft-for-member");
    expect(mocks.clearProject).toHaveBeenCalledWith(projectRef);
  });
  it("does no cleanup when deletion fails", async () => {
    const failure = AsyncResult.failure(Cause.fail(new Error("Rejected")));
    const result = await deleteLastCodeSidebarProject(
      member,
      vi.fn(async () => failure),
      [thread("target")],
    );
    expect(result).toBe(failure);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.clearDraft).not.toHaveBeenCalled();
    expect(mocks.clearProject).not.toHaveBeenCalled();
  });
});
