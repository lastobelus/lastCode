import { act, render } from "../../test/render";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { buildLinkedArchiveRecoveries } from "@t3tools/client-runtime/state/thread-archive";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { makeThreadFixture } from "../test-fixtures";
import { requestThreadArchiveDialog, ThreadArchiveDialogHost } from "./ThreadArchiveDialog";
import "~/index.css";

function button(label: string) {
  const target = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(target).toBeDefined();
  return target!;
}

function options(title = "Original child") {
  const child = makeThreadFixture({ id: ThreadId.make("child"), title });
  return {
    title: 'Archive "Planning task"?',
    family: {
      threads: [child],
      children: [child],
      activeThreadIds: [child.id],
      unreadThreadIds: [] as ThreadId[],
      protectedChildThreadIds: [] as ThreadId[],
      canStopAndArchive: true,
    },
  };
}

it("shows a pending restore alongside a newer archive and submits only the selected generation", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);
  const recoveries = buildLinkedArchiveRecoveries({
    linkedArchiveOperations: (["archive", "restore"] as const).map((operation, index) => ({
      operation,
      sourceArchiveCommandId: CommandId.make(operation),
      archivedAt: index === 0 ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
      machines: [
        {
          environmentId: EnvironmentId.make(operation),
          label: index === 0 ? "New machine" : "Older machine",
          status: "pending",
        },
      ],
    })),
  });
  const submit = vi.fn().mockResolvedValue(null);
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({
      title: "Linked archive status",
      family: { ...options().family, threads: [], children: [], activeThreadIds: [] },
      recoveries,
      submit,
    });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("New machine");
  await act(() => {
    const select = document.querySelector<HTMLSelectElement>("select")!;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Older machine");
  expect(dialog?.textContent).not.toContain("New machine");
  await act(() => button("Retry restore").click());
  await result;
  expect(submit).toHaveBeenCalledExactlyOnceWith("archive_after_review", undefined, recoveries[1]);
});

it("closes a failed action and requires a new confirmation for the fresh family", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);

  const submit = vi.fn().mockResolvedValue("The threads changed");
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...options(), submit });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Original child");
  await act(() => button("Stop active threads & archive").click());
  expect(await result).toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(submit).toHaveBeenCalledExactlyOnceWith("stop_and_archive", undefined);

  const freshSubmit = vi.fn().mockResolvedValue(null);
  await act(() => {
    result = requestThreadArchiveDialog({ ...options("New child"), submit: freshSubmit });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("New child");
  expect(freshSubmit).not.toHaveBeenCalled();
  await act(() => button("Stop active threads & archive").click());
  expect(await result).toBe("stop_and_archive");
  expect(freshSubmit).toHaveBeenCalledExactlyOnceWith("stop_and_archive", undefined);
});

it("confirms unread replies without granting permission to stop work", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);

  const request = options("Unread reply");
  const submit = vi.fn().mockResolvedValue(null);
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({
      ...request,
      family: {
        ...request.family,
        activeThreadIds: [],
        unreadThreadIds: [request.family.children[0]!.id],
      },
      submit,
    });
  });
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Unread reply");
  expect(dialog?.textContent).toContain("Replies stay in archived history");
  expect([...document.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Cancel",
    "Archive unread threads",
  ]);
  await act(() => button("Archive unread threads").click());
  expect(await result).toBe("archive_after_review");
  expect(submit).toHaveBeenCalledExactlyOnceWith("archive_after_review", undefined);
});

it("shows temporary projects that match the current archive choice before submitting", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);
  const request = options();
  const child = request.family.children[0]!;
  const submit = vi.fn().mockResolvedValue(null);
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({
      ...request,
      family: {
        ...request.family,
        keptThreadIds: [child.id],
        archivePreview: {
          environmentId: child.environmentId,
          typedInThreadIds: [child.id],
          threads: [{ threadId: child.id, title: child.title, projectId: child.projectId }],
          temporaryProjects: [
            {
              projectId: ProjectId.make("scratch"),
              title: "Scratch",
              threadIds: [],
              requiresTypedIn: false,
            },
            {
              projectId: ProjectId.make("opt-in"),
              title: "Opt-in project",
              threadIds: [],
              requiresTypedIn: true,
            },
          ],
        },
      },
      submit,
    });
  });
  await expect.element(page.getByText("Scratch", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/Unarchiving won't restore them/)).toBeVisible();
  await expect.element(page.getByText("Opt-in project")).not.toBeInTheDocument();
  await page.getByRole("checkbox", { name: /Also archive threads/ }).click();
  await expect.element(page.getByText("Opt-in project")).toBeVisible();
  expect(submit).not.toHaveBeenCalled();
  await act(() => button("Stop active threads & archive").click());
  expect(await result).toBe("stop_and_archive");
  expect(submit).toHaveBeenCalledExactlyOnceWith("stop_and_archive", true);
});

it.each(["returned", "thrown"] as const)(
  "closes a %s shutdown failure after one attempt",
  async (failure) => {
    await using _screen = await render(<ThreadArchiveDialogHost />);

    const submit =
      failure === "returned"
        ? vi.fn().mockResolvedValue("Shutdown failed")
        : vi.fn().mockRejectedValue(new Error("Shutdown failed"));
    let result!: ReturnType<typeof requestThreadArchiveDialog>;
    await act(() => {
      result = requestThreadArchiveDialog({ ...options(), submit });
    });
    await act(() => button("Stop active threads & archive").click());
    expect(await result).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(submit).toHaveBeenCalledExactlyOnceWith("stop_and_archive", undefined);
  },
);

it("cancels without submitting", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);

  const submit = vi.fn();
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...options(), submit });
  });
  await act(() => button("Cancel").click());
  expect(await result).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

it("shows a persistent family as blocked and closes without submitting", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);

  const request = options("Protected child");
  const child = { ...request.family.children[0]!, persistent: true };
  const submit = vi.fn();
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({
      ...request,
      family: {
        ...request.family,
        threads: [child],
        children: [child],
        protectedChildThreadIds: [child.id],
        canStopAndArchive: false,
      },
      submit,
    });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Protected child is persistent",
  );
  expect([...document.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Close",
  ]);
  await act(() => button("Close").click());
  expect(await result).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

it("keeps deferred Ask feedback in the dialog and closes after sending without archive consent", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);
  const request = options();
  const ownerThreadId = ThreadId.make("interactive-owner");
  const ask = vi.fn().mockResolvedValueOnce("This agent is busy.").mockResolvedValueOnce(null);
  const submit = vi.fn();
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({
      ...request,
      consultation: {
        environmentId: request.family.threads[0]!.environmentId,
        targets: [
          {
            ownerThreadId,
            ownerTitle: "Coordinator",
            work: [{ threadId: request.family.children[0]!.id }],
          },
        ],
        ask,
      },
      submit,
    });
  });
  await act(() => button("Ask the agent").click());
  expect(document.querySelector('[role="status"]')?.textContent).toBe("This agent is busy.");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(submit).not.toHaveBeenCalled();
  await act(() => button("Ask the agent").click());
  expect(await result).toBeNull();
  expect(ask).toHaveBeenNthCalledWith(1, ownerThreadId);
  expect(ask).toHaveBeenCalledTimes(2);
  expect(submit).not.toHaveBeenCalled();
});

it("reviews an unread conversation without authorizing archive", async () => {
  await using _screen = await render(<ThreadArchiveDialogHost />);
  const request = options();
  const review = vi.fn().mockResolvedValue(undefined);
  const submit = vi.fn();
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...request, review, submit });
  });
  await act(() => button("Review").click());
  expect(await result).toBeNull();
  expect(review).toHaveBeenCalledExactlyOnceWith({
    environmentId: request.family.threads[0]!.environmentId,
    threadId: request.family.threads[0]!.id,
  });
  expect(submit).not.toHaveBeenCalled();
});
