// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import type { LastCodeThreadActions } from "./LastCodeThreadActions";
import {
  LastCodeThreadArchiveControl,
  archiveLastCodeThread,
} from "./LastCodeThreadArchiveControl";
import { useLastCodeThreadEditing } from "./useLastCodeThreadEditing";
import { activateSidebarRowFromKeyboard } from "./sidebarRowKeyboard";
const mocks = vi.hoisted(() => ({
  archive: vi.fn<LastCodeThreadActions["archiveThread"]>(),
  confirm: true,
  canOperate: true,
  persistent: false,
  toast: vi.fn(),
  navigation: vi.fn(),
}));
vi.mock("./LastCodeThreadActions", () => ({
  useLastCodeThreadActions: () => ({ archiveThread: mocks.archive }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { confirmThreadArchive: boolean }) => unknown) =>
    select({ confirmThreadArchive: mocks.confirm }),
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => mocks.canOperate }));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => ({ persistent: mocks.persistent }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const thread = makeThreadFixture({
  environmentId: EnvironmentId.make("remote-member"),
  id: ThreadId.make("ordinary"),
  title: "Ordinary",
});
const ref = scopeThreadRef(thread.environmentId, thread.id);
function Harness() {
  const { archiveTarget, capabilities } = useLastCodeThreadEditing();
  return (
    <li
      onKeyDown={(event) => {
        activateSidebarRowFromKeyboard(event, mocks.navigation);
      }}
    >
      <LastCodeThreadArchiveControl
        thread={thread}
        confirming={archiveTarget === scopedThreadKey(ref)}
        editing={capabilities}
      />
      <button onClick={() => capabilities.cancelArchiveConfirmation(ref)}>Cancel</button>
    </li>
  );
}
let root: Root | null = null,
  container: HTMLDivElement | null = null;
let frames: FrameRequestCallback[] = [];
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() =>
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  }),
);
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm = true;
  mocks.canOperate = true;
  mocks.persistent = false;
  mocks.archive.mockResolvedValue(AsyncResult.success<undefined, never>(undefined));
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root?.render(<Harness />));
}
const button = (label: string) =>
  container!.querySelector<HTMLButtonElement>(`button[aria-label="${label} Ordinary"]`)!;
async function click(label: string) {
  await act(() => button(label).click());
}
async function flushFocus() {
  const pending = frames;
  frames = [];
  await act(() => pending.forEach((fn) => fn(0)));
}
describe("row-local archive control", () => {
  it("focuses inline confirmation and submits only the exact confirmed destination", async () => {
    await render();
    await click("Archive");
    expect(mocks.archive).not.toHaveBeenCalled();
    await flushFocus();
    expect(document.activeElement).toBe(button("Confirm archive"));
    await click("Confirm archive");
    expect(mocks.archive).toHaveBeenCalledWith(ref, { confirmed: true });
    expect(button("Archive")).not.toBeNull();
  });
  it("cancels its target and allows a fresh confirmation", async () => {
    await render();
    await click("Archive");
    await flushFocus();
    await act(() =>
      [...container!.querySelectorAll("button")].find((x) => x.textContent === "Cancel")!.click(),
    );
    expect(container!.querySelector('[aria-label="Confirm archive Ordinary"]')).toBeNull();
    expect(mocks.archive).not.toHaveBeenCalled();
    await click("Archive");
    await flushFocus();
    expect(document.activeElement).toBe(button("Confirm archive"));
  });
  it("keeps nested Enter from navigating while click activates archive", async () => {
    await render();
    const control = button("Archive");
    await act(() =>
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(mocks.navigation).not.toHaveBeenCalled();
    await click("Archive");
    await click("Confirm archive");
    expect(mocks.archive).toHaveBeenCalledOnce();
  });
  it("uses the shared ordinary/family confirmation path when inline confirmation is disabled", async () => {
    mocks.confirm = false;
    await render();
    await click("Archive");
    expect(mocks.archive).toHaveBeenCalledWith(ref);
    expect(container!.querySelector('[aria-label="Confirm archive Ordinary"]')).toBeNull();
  });
  it("rejects revoked permissions before opening and again before confirmed mutation", async () => {
    await render();
    mocks.canOperate = false;
    await click("Archive");
    expect(container!.querySelector('[aria-label="Confirm archive Ordinary"]')).toBeNull();
    mocks.canOperate = true;
    await click("Archive");
    mocks.canOperate = false;
    await click("Confirm archive");
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(container!.querySelector('[aria-label="Confirm archive Ordinary"]')).toBeNull();
  });
  it("rereads persistence at execution and reports the remedy without mutation", async () => {
    await render();
    await click("Archive");
    mocks.persistent = true;
    await click("Confirm archive");
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Persistent thread not archived" }),
    );
  });
  it("reports ordinary failures but does not report interruption", async () => {
    mocks.archive.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Denied"))));
    await archiveLastCodeThread(ref, false, mocks.archive);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to archive thread", description: "Denied" }),
    );
    mocks.toast.mockClear();
    mocks.archive.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await archiveLastCodeThread(ref, true, mocks.archive);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
