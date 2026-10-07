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
    children: [child],
    activeChildren: [child],
    canPromote: true,
    protectedCount: 0,
    nativeCount: 0,
  };
}

it("closes obsolete choices and requires a new confirmation before acting on the fresh family", async () => {
  const submit = vi.fn().mockResolvedValue({ error: "The subagents changed", close: true });
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...options(), submit });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Original child");
  await act(() => button("Stop and archive").click());
  expect(await result).toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(submit).toHaveBeenCalledExactlyOnceWith("stop_and_archive");

  const freshSubmit = vi.fn().mockResolvedValue(null);
  await act(() => {
    result = requestThreadArchiveDialog({ ...options("New child"), submit: freshSubmit });
  });
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("New child");
  expect(freshSubmit).not.toHaveBeenCalled();
  await act(() => button("Keep running separately").click());
  expect(await result).toBe("promote");
  expect(freshSubmit).toHaveBeenCalledExactlyOnceWith("promote");
});

it("keeps unchanged-family shutdown failures visible and retryable in the same confirmation", async () => {
  const submit = vi.fn().mockResolvedValueOnce("Shutdown failed").mockResolvedValueOnce(null);
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...options(), submit });
  });
  await act(() => button("Stop and archive").click());
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't archive. Shutdown failed",
  );
  expect(button("Stop and archive").disabled).toBe(false);
  await act(() => button("Stop and archive").click());
  expect(await result).toBe("stop_and_archive");
  expect(submit).toHaveBeenCalledTimes(2);
});
