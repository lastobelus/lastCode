import { act, render as renderUi } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLastCodeThreadFileDrop } from "./lastcodeThreadRowInteractions";
const first = scopeThreadRef(EnvironmentId.make("first"), ThreadId.make("same"));
const remote = scopeThreadRef(EnvironmentId.make("remote"), first.threadId);
const drop = vi.fn(),
  nextDrop = vi.fn();
function Harness({
  target = first,
  onDrop = drop,
}: {
  target?: ScopedThreadRef;
  onDrop?: typeof drop;
}) {
  const { isFileDragOver, fileDropHandlers } = useLastCodeThreadFileDrop(target, onDrop);
  return (
    <li {...fileDropHandlers}>
      <span>{isFileDragOver ? "Drop files" : "Thread"}</span>
      <button>Nested</button>
    </li>
  );
}
async function setup() {
  await using stack = new AsyncDisposableStack();
  vi.clearAllMocks();
  stack.defer(() => {
    vi.restoreAllMocks();
  });
  const screen = stack.use(await renderUi(null));
  const { container, rerender } = screen;
  async function render(props: Parameters<typeof Harness>[0] = {}) {
    await rerender(<Harness {...props} />);
  }
  const row = () => container.querySelector("li")!;
  const active = () => row().querySelector("span")!.textContent === "Drop files";
  async function drag(
    name: string,
    transfer = { types: ["Files"], files: [new File(["file"], "file.txt")], dropEffect: "none" },
    relatedTarget: EventTarget | null = null,
  ) {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      dataTransfer: { value: transfer },
      relatedTarget: { value: relatedTarget },
    });
    await act(() => row().dispatchEvent(event));
    return event;
  }
  const owner = stack.move();
  return {
    container,
    render,
    row,
    active,
    drag,
    rerender,
    [Symbol.asyncDispose]: () => owner.disposeAsync(),
  };
}
it("highlights file drags, sets copy effect and preserves internal movement", async () => {
  await using fixture = await setup();
  const { render, row, active, drag } = fixture;

  await render();
  const transfer = { types: ["Files"], files: [], dropEffect: "none" };
  expect((await drag("dragenter", transfer)).defaultPrevented).toBe(true);
  expect(active()).toBe(true);
  await drag("dragover", transfer);
  expect(transfer.dropEffect).toBe("copy");
  await drag("dragleave", transfer, row().querySelector("button"));
  expect(active()).toBe(true);
  await drag("dragleave", transfer);
  expect(active()).toBe(false);
});
it("leaves text drag events and navigation controls alone", async () => {
  await using fixture = await setup();
  const { render, active, drag } = fixture;

  await render();
  const transfer = { types: ["text/plain"], files: [], dropEffect: "none" };
  for (const name of ["dragenter", "dragover", "dragleave", "drop"])
    expect((await drag(name, transfer)).defaultPrevented).toBe(false);
  expect(active()).toBe(false);
  expect(drop).not.toHaveBeenCalled();
});
it("drops actual files on the scoped destination and resets its highlight", async () => {
  await using fixture = await setup();
  const { render, active, drag } = fixture;

  await render({ target: remote });
  const transfer = {
    types: ["Files"],
    files: [new File(["first"], "first.txt"), new File(["second"], "second.txt")],
    dropEffect: "none",
  };
  await drag("dragenter", transfer);
  expect(active()).toBe(true);
  expect((await drag("drop", transfer)).defaultPrevented).toBe(true);
  expect(active()).toBe(false);
  expect(drop).toHaveBeenCalledExactlyOnceWith(remote, transfer.files);
});
it("keeps folders excluded from row drops while forwarding file items", async () => {
  await using fixture = await setup();
  const { render, row } = fixture;

  await render();
  const file = new File(["file"], "file.txt"),
    folder = new File([], "folder");
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      files: [file, folder],
      dropEffect: "none",
      items: [
        { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) },
        { kind: "file", getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
      ],
    },
  });
  await act(() => row().dispatchEvent(event));
  expect(drop).toHaveBeenCalledExactlyOnceWith(first, [file]);
});
it("uses refreshed destination and callback without replacing the mounted row", async () => {
  await using fixture = await setup();
  const { render, row, active, drag } = fixture;

  await render();
  const before = row();
  await drag("dragenter");
  await render({ target: remote, onDrop: nextDrop });
  expect(row()).toBe(before);
  expect(active()).toBe(true);
  const transfer = { types: ["Files"], files: [new File(["new"], "new.txt")], dropEffect: "none" };
  await drag("drop", transfer);
  expect(drop).not.toHaveBeenCalled();
  expect(nextDrop).toHaveBeenCalledExactlyOnceWith(remote, transfer.files);
});
it("clears cancelled global drags and releases the exact listener on exit and unmount", async () => {
  await using fixture = await setup();
  const { rerender, render, active, drag } = fixture;

  const add = vi.spyOn(window, "addEventListener"),
    remove = vi.spyOn(window, "removeEventListener");
  await render();
  await drag("dragenter");
  const listeners = () =>
    add.mock.calls.filter(([name]) => name === "dragend").map(([, listener]) => listener);
  expect(listeners()).toHaveLength(1);
  await act(() => window.dispatchEvent(new Event("dragend")));
  expect(active()).toBe(false);
  expect(remove).toHaveBeenCalledWith("dragend", listeners()[0]);
  await drag("dragenter");
  expect(listeners()).toHaveLength(2);
  await rerender(null);
  expect(remove).toHaveBeenCalledWith("dragend", listeners()[1]);
});
