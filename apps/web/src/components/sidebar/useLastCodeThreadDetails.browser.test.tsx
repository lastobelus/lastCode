import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
const editing = {
  requestRename: vi.fn(),
  finishRename: vi.fn(),
  requestArchiveConfirmation: vi.fn(),
  cancelArchiveConfirmation: vi.fn(),
};
const observe = vi.fn<(value: ReturnType<typeof useLastCodeThreadDetails>) => void>();
const ref = scopeThreadRef(EnvironmentId.make("environment-one"), ThreadId.make("same-id"));
function Harness({ revision = 0 }: { revision?: number }) {
  const value = useLastCodeThreadDetails(ref, editing);
  useEffect(() => observe(value), [value]);
  const {
    handleMouseLeave,
    handleBlurCapture,
    threadNavigationRef,
    setThreadRowActive,
    threadRowActive,
  } = value;
  return (
    <>
      <ul>
        <li onMouseLeave={handleMouseLeave} onBlurCapture={handleBlurCapture}>
          <div ref={threadNavigationRef} tabIndex={0}>
            <button onClick={() => setThreadRowActive(true)}>Activate</button>
            <input />
          </div>
          <output>{String(threadRowActive)}</output>
          <span>{revision}</span>
        </li>
      </ul>
      <button>Outside</button>
    </>
  );
}
let root: Root, container: HTMLDivElement;
let frames: FrameRequestCallback[];
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
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(() => root.render(<Harness />));
}
async function activate() {
  await act(() => container.querySelector("button")!.click());
}
async function flushFocus() {
  await act(() => {
    const pending = frames.splice(0);
    for (const callback of pending) callback(0);
  });
}
const latest = () => observe.mock.calls.at(-1)![0];
describe("row details lifetime", () => {
  it("retains the handle, IDs and navigation anchor across row refresh", async () => {
    await render();
    const before = latest();
    const anchor = before.threadNavigationRef.current;
    await activate();
    await act(() => root.render(<Harness revision={1} />));
    const after = latest();
    expect(after.annotationPopoverHandle).toBe(before.annotationPopoverHandle);
    expect(after.annotationTriggerId).toBe(before.annotationTriggerId);
    expect(after.threadDetailsTooltipId).toBe(before.threadDetailsTooltipId);
    expect(after.threadNavigationRef.current).toBe(anchor);
    expect(container.querySelector("output")?.textContent).toBe("true");
  });
  it("cancels the exact row archive confirmation and deactivates on pointer exit", async () => {
    await render();
    await activate();
    await act(() =>
      container
        .querySelector("li")!
        .dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })),
    );
    expect(editing.cancelArchiveConfirmation).toHaveBeenCalledExactlyOnceWith(ref);
    expect(container.querySelector("output")?.textContent).toBe("false");
  });
  it("keeps details active for internal focus movement, then cancels on actual row exit", async () => {
    await render();
    await activate();
    await act(() => container.querySelector("button")!.focus());
    await act(() => container.querySelector("input")!.focus());
    await flushFocus();
    expect(editing.cancelArchiveConfirmation).not.toHaveBeenCalled();
    expect(container.querySelector("output")?.textContent).toBe("true");
    await act(() => container.querySelectorAll("button")[1]!.focus());
    await flushFocus();
    expect(editing.cancelArchiveConfirmation).toHaveBeenCalledExactlyOnceWith(ref);
    expect(container.querySelector("output")?.textContent).toBe("false");
  });
});
