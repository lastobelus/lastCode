// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import { requestThreadArchiveDialog, ThreadArchiveDialogHost } from "./ThreadArchiveDialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<ThreadArchiveDialogHost />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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

it("closes a failed action and requires a new confirmation for the fresh family", async () => {
  const submit = vi.fn().mockResolvedValue("The threads changed");
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...options(), submit });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Original child");
  await act(() => button("Stop active threads & archive").click());
  expect(await result).toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(submit).toHaveBeenCalledExactlyOnceWith("stop_and_archive");

  const freshSubmit = vi.fn().mockResolvedValue(null);
  await act(() => {
    result = requestThreadArchiveDialog({ ...options("New child"), submit: freshSubmit });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("New child");
  expect(freshSubmit).not.toHaveBeenCalled();
  await act(() => button("Stop active threads & archive").click());
  expect(await result).toBe("stop_and_archive");
  expect(freshSubmit).toHaveBeenCalledExactlyOnceWith("stop_and_archive");
});

it("confirms unread replies without granting permission to stop work", async () => {
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
  expect(submit).toHaveBeenCalledExactlyOnceWith("archive_after_review");
});

it.each(["returned", "thrown"] as const)(
  "closes a %s shutdown failure after one attempt",
  async (failure) => {
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
    expect(submit).toHaveBeenCalledExactlyOnceWith("stop_and_archive");
  },
);

it("cancels without submitting", async () => {
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
