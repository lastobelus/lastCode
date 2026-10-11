// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { makeThreadFixture } from "../../test-fixtures";
import { useLastCodeThreadAnnotations } from "./useLastCodeThreadAnnotations";
const mocks = vi.hoisted(() => ({
  upsert: vi.fn<(value: unknown) => Promise<AtomCommandResult<unknown, unknown>>>(),
  resolve: vi.fn<(value: unknown) => Promise<AtomCommandResult<unknown, unknown>>>(),
  toast: vi.fn(),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { upsertAnnotation: "upsert", resolveAnnotation: "resolve" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: string) =>
    command === "upsert" ? mocks.upsert : mocks.resolve,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const annotation = {
  anchorMessageId: MessageId.make("anchor"),
  body: "Original",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  resolvedAt: null,
};
const first = makeThreadFixture({
  id: ThreadId.make("same-id"),
  environmentId: EnvironmentId.make("first-env"),
  annotation,
});
const second = { ...first, environmentId: EnvironmentId.make("second-env") };
let actions: ReturnType<typeof useLastCodeThreadAnnotations>["actions"];
function Harness({ revision = 0 }: { revision?: number }) {
  const annotations = useLastCodeThreadAnnotations();
  useEffect(() => {
    actions = annotations.actions;
  }, [annotations.actions]);
  const [rowsVisible, setRowsVisible] = useState(true);
  return (
    <>
      <button onClick={() => setRowsVisible(!rowsVisible)}>
        {rowsVisible ? "Collapse" : "Expand"}
      </button>
      {rowsVisible && (
        <>
          <button onClick={() => annotations.actions.onEditAnnotation(first)}>Edit first</button>
          <button onClick={() => annotations.actions.onEditAnnotation(second)}>Edit second</button>
        </>
      )}
      <button onClick={() => void annotations.actions.onSaveAnnotationBody(first, "Hover first")}>
        Hover first
      </button>
      <button onClick={() => void annotations.actions.onSaveAnnotationBody(second, "Hover second")}>
        Hover second
      </button>
      <button onClick={() => void annotations.actions.onResolveAnnotation(second)}>
        Resolve second
      </button>
      <span>{revision}</span>
      {annotations.editor}
    </>
  );
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;
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
  mocks.upsert.mockResolvedValue(AsyncResult.success(undefined));
  mocks.resolve.mockResolvedValue(AsyncResult.success(undefined));
});
afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
});
async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root?.render(<Harness />));
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(() => button!.click());
}
const textarea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Thread annotation"]');
async function enter(value: string) {
  await act(() => {
    textarea()!.value = value;
    textarea()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("project-owned thread annotation editor", () => {
  it("keeps row actions stable while the project editor changes targets and saves the exact hover destination", async () => {
    await render();
    const original = actions;
    await click("Edit first");
    await enter("First draft");
    expect(actions).toBe(original);
    await click("Edit second");
    expect(actions).toBe(original);
    await click("Hover first");
    expect(mocks.upsert).toHaveBeenLastCalledWith({
      environmentId: first.environmentId,
      input: { threadId: first.id, body: "Hover first" },
    });
    expect(textarea()).not.toBeNull();
  });
  it("keeps the draft through project refresh and row collapse, then resets after cancel/reopen", async () => {
    await render();
    await click("Edit first");
    await enter("Draft");
    await act(() => root?.render(<Harness revision={1} />));
    await click("Collapse");
    expect(textarea()?.value).toBe("Draft");
    await click("Cancel");
    expect(textarea()).toBeNull();
    await click("Expand");
    await click("Edit first");
    expect(textarea()?.value).toBe("Original");
  });
  it("retains failed drafts, suppresses interruption and closes only on success", async () => {
    await render();
    await click("Edit second");
    await enter("  New body  ");
    mocks.upsert.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Denied"))));
    await click("Save");
    expect(textarea()?.value).toBe("  New body  ");
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save annotation" }),
    );
    mocks.toast.mockClear();
    mocks.upsert.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await click("Save");
    expect(textarea()).not.toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
    await click("Save");
    expect(textarea()).toBeNull();
    expect(mocks.upsert).toHaveBeenCalledWith({
      environmentId: second.environmentId,
      input: { threadId: second.id, body: "New body" },
    });
  });
  it("serializes hover/editor saves for one scoped thread while allowing the same ID in another environment", async () => {
    const pending = deferred<AtomCommandResult<unknown, unknown>>();
    mocks.upsert.mockReturnValueOnce(pending.promise);
    await render();
    await click("Hover first");
    await click("Edit first");
    await enter("Editor draft");
    await click("Save");
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(textarea()?.value).toBe("Editor draft");
    await click("Hover second");
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(AsyncResult.success(undefined));
      await pending.promise;
    });
    await click("Save");
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(textarea()).toBeNull();
  });
  it("resolves the exact destination and reports returned failures without treating interruption as failure", async () => {
    await render();
    mocks.resolve.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Resolve denied"))),
    );
    await click("Resolve second");
    expect(mocks.resolve).toHaveBeenCalledWith({
      environmentId: second.environmentId,
      input: { threadId: second.id },
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to resolve annotation" }),
    );
    mocks.toast.mockClear();
    mocks.resolve.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await click("Resolve second");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
