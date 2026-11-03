import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId, type SavedWorkspace } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SavedWorkspacesManager } from "./SavedWorkspacesSettings";
import "~/index.css";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  restore: vi.fn(),
  previewDiscard: vi.fn(),
  discard: vi.fn(),
  setKeep: vi.fn(),
  permission: { list: true, restore: true, previewDiscard: true, discard: true, setKeep: true },
  maintenance: { allowed: true, listeners: new Set<() => void>() },
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.family((name: keyof typeof state.permission) =>
    Atom.make(() => state.permission[name]),
  );
  const command = (name: keyof typeof state.permission) => ({
    name,
    permissionAtom: () => permission(name),
  });
  return {
    serverEnvironment: {
      listSavedWorkspaces: command("list"),
      restoreWorktree: command("restore"),
      previewWorktreeDiscard: command("previewDiscard"),
      discardWorktreeSnapshots: command("discard"),
      setKeepWorkspace: command("setKeep"),
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: keyof typeof state.permission }) => (input: unknown) =>
    state[command.name](input),
}));
vi.mock("../../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentScope: () =>
      useSyncExternalStore(
        (listener) => {
          const maintenance = state.maintenance;
          maintenance.listeners.add(listener);
          return () => maintenance.listeners.delete(listener);
        },
        () => state.maintenance.allowed,
      ),
    readEnvironmentScope: () => state.maintenance.allowed,
  };
});
vi.mock("./LastCodeStorageSettings", () => ({ SavedWorkspacesLaunch: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ connectedEnvironments: [], targets: [] }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId, id: projectId, title: "Recovery project" }],
}));

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const saved: SavedWorkspace = {
  snapshotId: "saved-copy-1",
  checkoutId: "checkout-1",
  title: "Example task",
  path: "/worktrees/example",
  projectIds: [projectId],
  ownerThreadIds: [ThreadId.make("thread")],
  savedAt: "2026-10-01T00:00:00.000Z",
  head: "abc123",
  branch: "example-work",
  bytes: 1024,
  fileCount: 4,
  current: true,
  orphaned: false,
  state: "suspended",
  keepWorkspace: false,
};
function setup() {
  state.maintenance = { allowed: true, listeners: new Set() };
  for (const command of [
    state.list,
    state.restore,
    state.previewDiscard,
    state.discard,
    state.setKeep,
  ])
    command.mockReset();
  state.permission = {
    list: true,
    restore: true,
    previewDiscard: true,
    discard: true,
    setKeep: true,
  };
  state.list.mockResolvedValue(AsyncResult.success({ entries: [saved], nextCursor: null }));
  state.restore.mockResolvedValue(
    AsyncResult.success({
      operationId: "restore-request",
      checkoutId: saved.checkoutId,
      state: "queued",
      message: "Restore accepted.",
    }),
  );
  state.previewDiscard.mockResolvedValue(
    AsyncResult.success({
      token: "exact-preview-token",
      checkoutId: saved.checkoutId,
      snapshots: [saved],
      bytes: 1024,
      retainedCount: 1,
      message: "One copy may be discarded; another owner's copy stays retained.",
    }),
  );
  state.discard.mockResolvedValue(
    AsyncResult.success({
      operationId: "discard-request",
      checkoutId: saved.checkoutId,
      state: "queued",
      message: "Discard accepted.",
    }),
  );
  state.setKeep.mockResolvedValue(
    AsyncResult.success({
      operationId: "hold-request",
      checkoutId: saved.checkoutId,
      state: "complete",
      message: "Keep workspace released.",
    }),
  );
}
function revokeMaintenance() {
  state.maintenance.allowed = false;
  for (const listener of state.maintenance.listeners) listener();
}
const manager = () => (
  <RegistryProvider>
    <SavedWorkspacesManager environmentId={environmentId} projectId={projectId} />
  </RegistryProvider>
);

it("loads a project-filtered page and explicitly loads the next page", async () => {
  setup();
  const history = {
    ...saved,
    snapshotId: "history-copy",
    current: false,
    title: "Earlier work",
    state: "active",
  };
  state.list
    .mockResolvedValueOnce(AsyncResult.success({ entries: [saved], nextCursor: 100 }))
    .mockResolvedValueOnce(AsyncResult.success({ entries: [history], nextCursor: null }));
  await using screen = await render(manager());
  await expect.element(screen.getByText("Example task", { exact: true })).toBeVisible();
  expect(state.list).toHaveBeenNthCalledWith(1, { environmentId, input: { projectId } });
  await screen.getByRole("button", { name: "Load more saved workspaces" }).click();
  await expect.element(screen.getByText("Earlier work", { exact: true })).toBeVisible();
  expect(state.list).toHaveBeenNthCalledWith(2, {
    environmentId,
    input: { projectId, cursor: 100 },
  });
  await expect.element(screen.getByText(/2 saved copies shown/)).toBeVisible();
});

it("requires the exact discard preview and confirmation without restoring first", async () => {
  setup();
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Discard saved workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard saved workspace data?" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText(/1 shared or retained copy stays protected/)).toBeVisible();
  await expect.element(dialog.getByText("saved-copy-1", { exact: true })).toBeVisible();
  expect(state.discard).not.toHaveBeenCalled();
  expect(state.restore).not.toHaveBeenCalled();
  expect(state.previewDiscard).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { checkoutId: saved.checkoutId, snapshotIds: [saved.snapshotId] },
  });
  await dialog.getByRole("button", { name: "Discard saved workspace data", exact: true }).click();
  expect(state.discard).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { previewToken: "exact-preview-token" },
  });
  expect(state.restore).not.toHaveBeenCalled();
  await expect.element(screen.getByText(/Request discard-request was queued/)).toBeVisible();
});

it("cancels discard without deleting data", async () => {
  setup();
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Discard saved workspace", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Keep saved data" }).click();
  expect(state.discard).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("shows a queued restore and uses Refresh to display authoritative state", async () => {
  setup();
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Restore worktree", exact: true }).click();
  expect(state.restore).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { checkoutId: saved.checkoutId, snapshotId: saved.snapshotId },
  });
  await expect.element(screen.getByText(/Request restore-request was queued/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Restore worktree", exact: true }))
    .toBeDisabled();
  state.list.mockResolvedValue(
    AsyncResult.success({
      entries: [{ ...saved, current: false, state: "active", keepWorkspace: true }],
      nextCursor: null,
    }),
  );
  await screen.getByRole("button", { name: "Refresh saved workspaces" }).click();
  await expect.element(screen.getByText(/Historical saved copy · active/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Release Keep workspace" }))
    .toBeVisible();
  expect(state.list).toHaveBeenCalledTimes(2);
});

it("restores a current copy to an alternate managed path after the original path is occupied", async () => {
  setup();
  state.restore.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("The original restore path is occupied."))),
  );
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Restore worktree", exact: true }).click();
  await expect.element(screen.getByText(/original restore path is occupied/)).toBeVisible();
  await screen.getByRole("button", { name: "Restore to another location", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Restore at another location" });
  await expect.element(dialog.getByText(/for its existing threads/)).toBeVisible();
  await expect
    .element(dialog.getByRole("combobox", { name: "Recovery project" }))
    .not.toBeInTheDocument();
  const restore = dialog.getByRole("button", {
    name: "Restore at alternate location",
    exact: true,
  });
  await expect.element(restore).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "Alternate managed worktree path" })
    .fill("/worktrees/alternate-example");
  await restore.click();
  expect(state.restore).toHaveBeenNthCalledWith(1, {
    environmentId,
    input: { checkoutId: saved.checkoutId, snapshotId: saved.snapshotId },
  });
  expect(state.restore).toHaveBeenNthCalledWith(2, {
    environmentId,
    input: {
      checkoutId: saved.checkoutId,
      snapshotId: saved.snapshotId,
      destinationPath: "/worktrees/alternate-example",
    },
  });
  await expect.element(screen.getByText(/Request restore-request was queued/)).toBeVisible();
});

it("releases an orphan's hold by checkout identity and then allows its discard preview", async () => {
  setup();
  const held = { ...saved, current: false, orphaned: true, keepWorkspace: true };
  state.list.mockResolvedValueOnce(AsyncResult.success({ entries: [held], nextCursor: null }));
  state.list.mockResolvedValue(
    AsyncResult.success({ entries: [{ ...held, keepWorkspace: false }], nextCursor: null }),
  );
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Release Keep workspace" }).click();
  expect(state.setKeep).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { checkoutId: saved.checkoutId, keep: false },
  });
  await expect
    .element(screen.getByText("Keep workspace is on.", { exact: false }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Discard saved workspace", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Discard saved workspace data?" }))
    .toBeVisible();
  expect(state.previewDiscard).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { checkoutId: saved.checkoutId, snapshotIds: [saved.snapshotId] },
  });
  expect(state.restore).not.toHaveBeenCalled();
});

it("revokes an already loaded orphan's hold-release permission", async () => {
  setup();
  state.list.mockResolvedValue(
    AsyncResult.success({
      entries: [{ ...saved, orphaned: true, keepWorkspace: true }],
      nextCursor: null,
    }),
  );
  await using screen = await render(manager());
  const release = screen.getByRole("button", { name: "Release Keep workspace" });
  await expect.element(release).toBeEnabled();
  revokeMaintenance();
  await expect.element(release).toBeDisabled();
  expect(state.setKeep).not.toHaveBeenCalled();
});

it("does not read without the destination read grant", async () => {
  setup();
  state.permission.list = false;
  await using screen = await render(manager());
  await expect.element(screen.getByText(/lacks permission to read saved workspaces/)).toBeVisible();
  expect(state.list).not.toHaveBeenCalled();
});

it("restores historical or orphaned data only into an explicitly chosen recovery destination", async () => {
  setup();
  state.list.mockResolvedValue(
    AsyncResult.success({
      entries: [{ ...saved, current: false, orphaned: true, state: "active" }],
      nextCursor: null,
    }),
  );
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Restore as recovery worktree" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore a separate recovery worktree" });
  const restore = dialog.getByRole("button", { name: "Restore recovery worktree", exact: true });
  await expect.element(restore).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "New recovery worktree path" })
    .fill("/worktrees/recovered-example");
  await restore.click();
  expect(state.restore).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      checkoutId: saved.checkoutId,
      snapshotId: saved.snapshotId,
      projectId,
      destinationPath: "/worktrees/recovered-example",
    },
  });
  await expect.element(screen.getByText(/Request restore-request was queued/)).toBeVisible();
});

it("requires an existing project for a historical copy even after a destination is entered", async () => {
  setup();
  state.list.mockResolvedValue(
    AsyncResult.success({ entries: [{ ...saved, current: false }], nextCursor: null }),
  );
  await using screen = await render(
    <RegistryProvider>
      <SavedWorkspacesManager environmentId={environmentId} projectId={null} />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Restore as recovery worktree" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore a separate recovery worktree" });
  await dialog
    .getByRole("textbox", { name: "New recovery worktree path" })
    .fill("/worktrees/history");
  const restore = dialog.getByRole("button", { name: "Restore recovery worktree", exact: true });
  await expect.element(restore).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Recovery project" }).click();
  await page.getByRole("option", { name: "Recovery project", exact: true }).click();
  await restore.click();
  expect(state.restore).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      checkoutId: saved.checkoutId,
      snapshotId: saved.snapshotId,
      projectId,
      destinationPath: "/worktrees/history",
    },
  });
});

it("revokes orphan recovery and discard access for an already loaded copy and open recovery form", async () => {
  setup();
  state.list.mockResolvedValue(
    AsyncResult.success({ entries: [{ ...saved, orphaned: true }], nextCursor: null }),
  );
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Restore as recovery worktree" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore a separate recovery worktree" });
  await dialog
    .getByRole("textbox", { name: "New recovery worktree path" })
    .fill("/worktrees/orphan");
  await expect
    .element(dialog.getByRole("button", { name: "Restore recovery worktree", exact: true }))
    .toBeEnabled();
  revokeMaintenance();
  await expect
    .element(dialog.getByRole("button", { name: "Restore recovery worktree", exact: true }))
    .toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Restore as recovery worktree" }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Discard saved workspace", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByText(/Environment maintenance permission is required/))
    .toBeVisible();
  expect(state.restore).not.toHaveBeenCalled();
  expect(state.previewDiscard).not.toHaveBeenCalled();
  expect(state.list).toHaveBeenCalledTimes(1);
});

it("revokes an orphan discard confirmation that was opened before the grant changed", async () => {
  setup();
  const orphan = { ...saved, orphaned: true };
  state.list.mockResolvedValue(AsyncResult.success({ entries: [orphan], nextCursor: null }));
  state.previewDiscard.mockResolvedValue(
    AsyncResult.success({
      token: "orphan-preview-token",
      checkoutId: orphan.checkoutId,
      snapshots: [orphan],
      bytes: orphan.bytes,
      retainedCount: 0,
      message: "The orphaned saved copy may be discarded.",
    }),
  );
  await using screen = await render(manager());
  await screen.getByRole("button", { name: "Discard saved workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard saved workspace data?" });
  const discard = dialog.getByRole("button", { name: "Discard saved workspace data", exact: true });
  await expect.element(discard).toBeEnabled();
  revokeMaintenance();
  await expect.element(discard).toBeDisabled();
  expect(state.discard).not.toHaveBeenCalled();
  expect(state.restore).not.toHaveBeenCalled();
});

it("disables restore and discard when their grants are missing", async () => {
  setup();
  state.permission.restore = false;
  state.permission.discard = false;
  await using screen = await render(manager());
  await expect
    .element(screen.getByRole("button", { name: "Restore worktree", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Discard saved workspace", exact: true }))
    .toBeDisabled();
  expect(state.restore).not.toHaveBeenCalled();
  expect(state.previewDiscard).not.toHaveBeenCalled();
});

it("keeps in-progress recovery operations protected", async () => {
  setup();
  state.list.mockResolvedValue(
    AsyncResult.success({ entries: [{ ...saved, state: "restoring" }], nextCursor: null }),
  );
  await using screen = await render(manager());
  await expect
    .element(screen.getByRole("button", { name: "Discard saved workspace", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Restore worktree", exact: true }))
    .not.toBeInTheDocument();
  expect(state.previewDiscard).not.toHaveBeenCalled();
});

it("allows a stopped recovery to be retried while keeping discard protected", async () => {
  setup();
  state.list.mockResolvedValue(
    AsyncResult.success({
      entries: [
        {
          ...saved,
          state: "restoring",
          blockedReason: "The source repository is unavailable. Reconnect it, then retry recovery.",
        },
      ],
      nextCursor: null,
    }),
  );
  await using screen = await render(manager());
  await expect
    .element(
      screen.getByText("The source repository is unavailable. Reconnect it, then retry recovery."),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Discard saved workspace", exact: true }))
    .toBeDisabled();
  await screen.getByRole("button", { name: "Retry recovery", exact: true }).click();
  await expect.element(screen.getByText(/Request restore-request was queued/)).toBeVisible();
});
