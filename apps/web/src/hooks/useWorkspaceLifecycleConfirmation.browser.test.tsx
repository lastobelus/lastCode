import { RegistryProvider } from "@effect/atom-react";
import type { ThreadArchiveFamily } from "@t3tools/client-runtime/state/thread-archive";
import { EnvironmentId, ProjectId, ThreadId, type SavedWorkspace } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { WorkspaceLifecycleDialogHost } from "../components/WorkspaceLifecycleDialog";
import { makeThreadFixture } from "../test-fixtures";
import {
  groupThreadDeletionTargets,
  useWorkspaceLifecycleConfirmation,
} from "./useWorkspaceLifecycleConfirmation";
import "~/index.css";

const state = vi.hoisted(() => ({ preview: vi.fn(), canDiscard: true, toast: vi.fn() }));
vi.mock("../state/entities", () => ({ readProject: () => null }));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      previewWorkspaceLifecycle: { name: "preview" },
      configValueAtom: Atom.family(() =>
        Atom.make({ environment: { capabilities: { worktreeSuspension: true } } }),
      ),
      discardWorktreeSnapshots: {
        permissionAtom: Atom.family(() => Atom.make(() => state.canDiscard)),
      },
      deleteThreads: { permissionAtom: Atom.family(() => Atom.make(() => state.canDiscard)) },
    },
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => state.preview(input),
}));
const environmentId = EnvironmentId.make("environment");
const snapshot: SavedWorkspace = {
  snapshotId: "exact-copy",
  checkoutId: "checkout",
  title: "Saved work",
  path: "/managed/work",
  projectIds: [],
  ownerThreadIds: [ThreadId.make("thread")],
  savedAt: "2026-10-01T00:00:00.000Z",
  head: "abc123",
  branch: "feature",
  bytes: 4096,
  fileCount: 3,
  current: true,
  orphaned: false,
  state: "suspended",
  keepWorkspace: false,
};
function setup() {
  state.preview.mockReset();
  state.toast.mockReset();
  state.canDiscard = true;
  state.preview.mockResolvedValue(
    AsyncResult.success({
      token: "reviewed-token",
      snapshots: [snapshot],
      retainedSnapshots: [],
      bytes: 4096,
      threadIds: snapshot.ownerThreadIds,
      projectIds: [],
      message: "Exact saved copy.",
    }),
  );
}
function Scenario({
  bulk = false,
  archiveFamily,
}: {
  bulk?: boolean;
  archiveFamily?: ThreadArchiveFamily;
}) {
  const lifecycle = useWorkspaceLifecycleConfirmation();
  const [result, setResult] = useState("");
  return (
    <>
      <WorkspaceLifecycleDialogHost />
      <button
        onClick={() =>
          void lifecycle
            .confirm(
              archiveFamily
                ? [
                    {
                      environmentId,
                      input: {
                        operation: "archive",
                        target: { kind: "threads", threadIds: [ThreadId.make("thread")] },
                      },
                    },
                  ]
                : groupThreadDeletionTargets(
                    (bulk ? ["thread", "second"] : ["thread"]).map((id) => ({
                      environmentId,
                      threadId: ThreadId.make(id),
                    })),
                  ),
              archiveFamily
                ? {
                    title: "Archive thread?",
                    description: "Review the archive and saved copies.",
                    archiveFamily,
                  }
                : {
                    title: "Delete thread?",
                    description: "The conversation and its owned subagents will be deleted.",
                  },
            )
            .then((choice) =>
              setResult(choice === null ? "Cancelled" : JSON.stringify(choice.dispositions)),
            )
            .catch((error) => setResult(String(error)))
        }
      >
        {archiveFamily ? "Archive with saved copies" : "Delete"}
      </button>
      <output>{result}</output>
    </>
  );
}
it("reviews exact saved copies and starts with discard selected", async () => {
  setup();
  await using screen = await render(
    <RegistryProvider>
      <Scenario />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .element(page.getByText("1 saved copy · 1 current · 0 historical · 4.00 KB"))
    .toBeVisible();
  await expect
    .element(page.getByRole("checkbox", { name: "Discard saved workspace data" }))
    .toBeChecked();
  await expect.element(page.getByText("/managed/work · exact-copy")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and discard saved data" }).click();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent('[{"mode":"discard","previewToken":"reviewed-token"}]');
});

it.each([false, true])(
  "uses the saved-copy preview for archive consent with opt-in %s",
  async (includeTypedIn) => {
    setup();
    const root = makeThreadFixture({
      environmentId,
      id: ThreadId.make("thread"),
      title: "Archive root",
    });
    const child = makeThreadFixture({
      environmentId,
      id: ThreadId.make("child"),
      title: "Typed-in child",
    });
    const shared = { ...snapshot, ownerThreadIds: [root.id, child.id] };
    state.preview.mockImplementation(async ({ input }) => {
      const includeChild = input.target.archiveThreadIds?.includes(child.id) === true;
      return AsyncResult.success({
        token: includeChild ? "expanded-preview" : "default-preview",
        snapshots: includeChild ? [shared] : [],
        retainedSnapshots: includeChild ? [] : [shared],
        bytes: includeChild ? shared.bytes : 0,
        threadIds: includeChild ? [root.id, child.id] : [root.id],
        projectIds: [],
        message: "Saved data.",
      });
    });
    await using screen = await render(
      <RegistryProvider>
        <Scenario
          archiveFamily={{
            threads: [root, child],
            children: [child],
            childThreadIds: [child.id],
            activeThreadIds: [],
            activeChildThreadIds: [],
            activeThreads: [],
            activeChildren: [],
            unreadThreadIds: [],
            unreadThreads: [],
            protectedChildThreadIds: [],
            protectedChildren: [],
            promotableChildThreadIds: [],
            keptThreadIds: [child.id],
            nativeStopCount: 0,
            canPromote: false,
            canStopAndArchive: true,
            requiresConfirmation: true,
            archivePreview: {
              environmentId,
              threads: [root, child].map(({ id, title, projectId }) => ({
                threadId: id,
                title,
                projectId,
              })),
              typedInThreadIds: [child.id],
              temporaryProjects: [
                { projectId: ProjectId.make("scratch"), title: "Scratch", requiresTypedIn: false },
                {
                  projectId: ProjectId.make("opt-in"),
                  title: "Opt-in project",
                  requiresTypedIn: true,
                },
              ],
            },
          }}
        />
      </RegistryProvider>,
    );
    await screen.getByRole("button", { name: "Archive with saved copies" }).click();
    const savedCopies = page.getByRole("list", { name: "Saved copies to discard" });
    await expect
      .element(page.getByRole("list", { name: "Saved copies retained" }).getByText(/Saved work/))
      .toBeVisible();
    await expect.element(savedCopies).not.toBeInTheDocument();
    await expect.element(page.getByText("Scratch", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Unarchiving won't restore them/)).toBeVisible();
    await expect.element(page.getByText("Opt-in project")).not.toBeInTheDocument();
    if (includeTypedIn) {
      await page.getByRole("checkbox", { name: /Also archive threads/ }).click();
      await expect.element(savedCopies.getByText(/Saved work/)).toBeVisible();
      await expect.element(page.getByText("Opt-in project")).toBeVisible();
    }
    await page.getByRole("button", { name: "Confirm and discard saved data" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent(
      JSON.stringify([
        {
          mode: "discard",
          previewToken: includeTypedIn ? "expanded-preview" : "default-preview",
        },
      ]),
    );
  },
);
it("keeps recovery data without a disposal grant", async () => {
  setup();
  state.canDiscard = false;
  await using screen = await render(
    <RegistryProvider>
      <Scenario />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Confirm and discard saved data" }))
    .toBeDisabled();
  await page.getByRole("checkbox", { name: "Discard saved workspace data" }).click();
  await expect
    .element(
      page.getByText(
        "Keep these saved copies for recovery in Settings → Storage → Saved workspaces.",
      ),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Confirm and keep for recovery" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent('[{"mode":"retain"}]');
});
it("shows shared protected copies and cancels without granting disposal", async () => {
  setup();
  state.preview.mockResolvedValue(
    AsyncResult.success({
      token: "reviewed-token",
      snapshots: [],
      retainedSnapshots: [snapshot],
      bytes: 0,
      threadIds: snapshot.ownerThreadIds,
      projectIds: [],
      message: "Shared saved copies stay.",
    }),
  );
  await using screen = await render(
    <RegistryProvider>
      <Scenario />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .element(page.getByText("1 shared or protected saved copy will be retained."))
    .toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Cancelled");
});
it("reviews the complete same-environment owner selection once", async () => {
  setup();
  state.preview.mockImplementation(
    async (target: { input: { target: { threadIds: readonly string[] } } }) =>
      AsyncResult.success({
        token: target.input.target.threadIds.join("+"),
        snapshots: [snapshot],
        retainedSnapshots: [],
        bytes: 4096,
        threadIds: target.input.target.threadIds,
        projectIds: [],
        message: "Saved data.",
      }),
  );
  await using screen = await render(
    <RegistryProvider>
      <Scenario bulk />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .element(page.getByText("1 saved copy · 1 current · 0 historical · 4.00 KB"))
    .toBeVisible();
  await page.getByRole("button", { name: "Confirm and discard saved data" }).click();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent('[{"mode":"discard","previewToken":"second+thread"}]');
});

it("requires a narrower operation when an exact bulk inventory is too large", async () => {
  setup();
  state.preview.mockResolvedValue(
    AsyncResult.success({
      token: "bounded-preview",
      snapshots: Array.from({ length: 101 }, (_, index) => ({
        ...snapshot,
        snapshotId: `copy-${index}`,
      })),
      retainedSnapshots: [],
      bytes: 413696,
      threadIds: snapshot.ownerThreadIds,
      projectIds: [],
      message: "Too many copies.",
    }),
  );
  await using screen = await render(
    <RegistryProvider>
      <Scenario bulk />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Cancelled");
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Review a smaller selection" }),
  );
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
});

it("does not grant deletion consent when the authoritative saved-copy review fails", async () => {
  setup();
  state.preview.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new Error("A restore is in progress."))),
  );
  await using screen = await render(
    <RegistryProvider>
      <Scenario />
    </RegistryProvider>,
  );
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Cancelled");
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Saved workspace review could not load",
      description: "A restore is in progress.",
    }),
  );
});
