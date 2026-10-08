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
    canStopAndArchive: true,
    protectedCount: 0,
    nativeCount: 0,
  };
}

it("closes obsolete choices and requires a new confirmation before acting on the fresh family", async () => {
  const submit = vi.fn().mockResolvedValue("The subagents changed");
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

it("closes an unchanged-family shutdown failure after one attempt", async () => {
  const submit = vi.fn().mockResolvedValue("Shutdown failed");
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...options(), submit });
  });
  await act(() => button("Stop and archive").click());
  expect(await result).toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(submit).toHaveBeenCalledExactlyOnceWith("stop_and_archive");
});

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

it("uses the server stop permission even when the display shells are unprotected", async () => {
  const submit = vi.fn().mockResolvedValue(null);
  let result!: ReturnType<typeof requestThreadArchiveDialog>;
  await act(() => {
    result = requestThreadArchiveDialog({ ...options(), canStopAndArchive: false, submit });
  });
  expect(button("Stop and archive").disabled).toBe(true);
  expect(button("Keep running separately").disabled).toBe(false);
  await act(() => button("Keep running separately").click());
  expect(await result).toBe("promote");
  expect(submit).toHaveBeenCalledExactlyOnceWith("promote");
});
