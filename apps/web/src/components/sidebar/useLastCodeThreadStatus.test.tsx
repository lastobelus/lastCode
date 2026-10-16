// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vite-plus/test";
import { EnvironmentId, RunId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { useLastCodeThreadStatus } from "./useLastCodeThreadStatus";
const earlier = "2026-03-09T10:04:00.000Z",
  later = "2026-03-09T10:06:00.000Z";
const first = {
  ...makeThreadFixture({
    environmentId: EnvironmentId.make("first"),
    latestRun: {
      runId: RunId.make("completed"),
      status: "completed",
      assistantMessageId: null,
      requestedAt: earlier,
      startedAt: earlier,
      completedAt: "2026-03-09T10:05:00.000Z",
    },
  }),
};
delete first.lastVisitedAt;
const remote = { ...first, environmentId: EnvironmentId.make("remote") };
const key = (thread: typeof first) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
function Status({ thread }: { thread: typeof first }) {
  const status = useLastCodeThreadStatus(thread);
  return <output data-environment={thread.environmentId}>{status?.label ?? "Read"}</output>;
}
let root: Root, container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
let previous: Record<string, string>;
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
  previous = useUiStateStore.getState().threadLastVisitedAtById;
  useUiStateStore.setState({
    threadLastVisitedAtById: { [key(first)]: earlier, [key(remote)]: earlier },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  useUiStateStore.setState({ threadLastVisitedAtById: previous });
});
async function render(serverLastVisitedAt: string | null | undefined = undefined) {
  await act(() =>
    root.render(
      <>
        <Status
          thread={{
            ...first,
            ...(serverLastVisitedAt === undefined ? {} : { lastVisitedAt: serverLastVisitedAt }),
          }}
        />
        <Status thread={remote} />
      </>,
    ),
  );
}
const label = (environment: string) =>
  container.querySelector(`output[data-environment="${environment}"]`)?.textContent;
it("updates only the visited destination when two environments reuse a thread ID", async () => {
  await render();
  expect(label("first")).toBe("Completed");
  expect(label("remote")).toBe("Completed");
  await act(() =>
    useUiStateStore.setState({
      threadLastVisitedAtById: {
        ...useUiStateStore.getState().threadLastVisitedAtById,
        [key(first)]: later,
      },
    }),
  );
  expect(label("first")).toBe("Read");
  expect(label("remote")).toBe("Completed");
});
it("keeps the server visit rewind authoritative over a newer local watermark", async () => {
  useUiStateStore.setState({ threadLastVisitedAtById: { [key(first)]: later } });
  await render(earlier);
  expect(label("first")).toBe("Completed");
  await render(later);
  expect(label("first")).toBe("Read");
});
it("treats an explicit server null as read while omitted tracking uses local visits", async () => {
  await render(null);
  expect(label("first")).toBe("Read");
  await render();
  expect(label("first")).toBe("Completed");
});
