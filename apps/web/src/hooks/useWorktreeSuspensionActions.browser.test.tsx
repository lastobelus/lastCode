import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type WorktreeSuspensionSummary } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import type { SidebarThreadSummary } from "../types";
import { useWorktreeSuspensionActions } from "./useWorktreeSuspensionActions";

const state = vi.hoisted(() => ({
  thread: null as SidebarThreadSummary | null,
  pending: null as Promise<boolean> | null,
  canRun: true,
  confirm: vi.fn(),
  preview: vi.fn(),
  suspend: vi.fn(),
  restore: vi.fn(),
  keep: vi.fn(),
  fresh: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const command = (name: "preview" | "suspend" | "restore" | "keep" | "fresh") => ({
    name,
    permissionAtom: () => Atom.make(state.canRun),
  });
  return {
    serverEnvironment: {
      configValueAtom: () =>
        Atom.make({ environment: { capabilities: { worktreeSuspension: true } } }),
      previewWorktreeSuspension: command("preview"),
      suspendWorktree: command("suspend"),
      restoreWorktree: command("restore"),
      setKeepWorkspace: command("keep"),
      createFreshWorktree: command("fresh"),
      discardWorktreeSnapshots: command("suspend"),
    },
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { name: "preview" | "suspend" | "restore" | "keep" | "fresh" }) => (input: unknown) =>
      state[command.name](input),
}));
vi.mock("../state/entities", () => ({ readThreadShell: () => state.thread }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) }));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));

const environmentId = EnvironmentId.make("remote-environment");
const threadId = ThreadId.make("thread");
const ref = scopeThreadRef(environmentId, threadId);
const summary: WorktreeSuspensionSummary = {
  checkoutId: "checkout",
  generation: 1,
  state: "suspended",
  snapshotId: "current-copy",
  lastRestoredAt: null,
  keepWorkspace: false,
};
function setup() {
  for (const mock of [
    state.confirm,
    state.preview,
    state.suspend,
    state.restore,
    state.keep,
    state.fresh,
    state.toast,
  ])
    mock.mockReset();
  state.pending = null;
  state.canRun = true;
  state.thread = makeThreadFixture({
    id: threadId,
    environmentId,
    worktreePath: "/worktrees/example",
  });
  state.confirm.mockResolvedValue(true);
  state.preview.mockResolvedValue(
    AsyncResult.success({
      token: "exact-token",
      checkoutId: "checkout",
      path: "/worktrees/example",
      ownerThreadIds: [threadId],
      message: "Exact checkout preview.",
    }),
  );
  for (const mock of [state.suspend, state.restore, state.keep, state.fresh])
    mock.mockResolvedValue(
      AsyncResult.success({
        operationId: "request",
        checkoutId: "checkout",
        state: "queued",
        message: "Request accepted.",
      }),
    );
}
function Harness({ action }: { readonly action: string }) {
  const actions = useWorktreeSuspensionActions();
  return (
    <button
      onClick={() => {
        state.pending = actions.run(action, ref);
      }}
    >
      Run workspace action
    </button>
  );
}
const harness = (action: string) => (
  <RegistryProvider>
    <Harness action={action} />
  </RegistryProvider>
);
async function run(screen: Awaited<ReturnType<typeof render>>) {
  await act(async () => {
    screen.container.querySelector("button")!.click();
    await state.pending;
  });
}
it("suspends only after an exact checkout preview is confirmed", async () => {
  setup();
  await using screen = await render(harness("workspace-suspend"));
  await run(screen);
  expect(state.preview).toHaveBeenCalledExactlyOnceWith({ environmentId, input: { threadId } });
  expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("/worktrees/example"));
  expect(state.suspend).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, previewToken: "exact-token" },
  });
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Workspace request queued" }),
  );
});
it("keeps the checkout when suspension confirmation is cancelled", async () => {
  setup();
  state.confirm.mockResolvedValue(false);
  await using screen = await render(harness("workspace-suspend"));
  await run(screen);
  expect(state.preview).toHaveBeenCalledTimes(1);
  expect(state.suspend).not.toHaveBeenCalled();
});
it("restores the latest current saved copy from the destination thread", async () => {
  setup();
  await using screen = await render(harness("workspace-restore"));
  state.thread = {
    ...state.thread!,
    source: {
      ...state.thread!.source,
      worktreeSuspension: { ...summary, snapshotId: "new-current-copy" },
    },
  };
  await run(screen);
  expect(state.restore).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { checkoutId: "checkout", snapshotId: "new-current-copy" },
  });
});
it("blocks a workspace action after the destination grant is revoked", async () => {
  setup();
  await using screen = await render(harness("workspace-suspend"));
  state.canRun = false;
  await run(screen);
  expect(state.preview).not.toHaveBeenCalled();
  expect(state.suspend).not.toHaveBeenCalled();
});
it("releases an explicit hold only after explaining automatic cleanup eligibility", async () => {
  setup();
  state.thread = {
    ...state.thread!,
    source: {
      ...state.thread!.source,
      worktreeSuspension: { ...summary, state: "active", keepWorkspace: true },
    },
  };
  await using screen = await render(harness("workspace-release"));
  await run(screen);
  expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("Already-old resources"));
  expect(state.keep).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { threadId, keep: false },
  });
});
it("requires a separate fresh-checkout decision after deliberate disposal", async () => {
  setup();
  state.thread = {
    ...state.thread!,
    source: {
      ...state.thread!.source,
      worktreeSuspension: { ...summary, state: "discarded", snapshotId: null },
    },
  };
  await using screen = await render(harness("workspace-create-fresh"));
  await run(screen);
  expect(state.confirm).toHaveBeenCalledWith(
    expect.stringContaining("Discarded local files and notes cannot be recovered"),
  );
  expect(state.fresh).toHaveBeenCalledExactlyOnceWith({ environmentId, input: { threadId } });
  expect(state.restore).not.toHaveBeenCalled();
});
