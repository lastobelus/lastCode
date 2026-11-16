import { act, render as renderUi } from "../../../test/render";
import { expect, it } from "vite-plus/test";
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
async function setup() {
  await using stack = new AsyncDisposableStack();
  const previous = useUiStateStore.getState().threadLastVisitedAtById;
  stack.defer(() => {
    useUiStateStore.setState({ threadLastVisitedAtById: previous });
  });
  useUiStateStore.setState({
    threadLastVisitedAtById: { [key(first)]: earlier, [key(remote)]: earlier },
  });
  const screen = stack.use(await renderUi(null));
  const { container, rerender } = screen;
  async function render(serverLastVisitedAt: string | null | undefined = undefined) {
    await rerender(
      <>
        <Status
          thread={{
            ...first,
            ...(serverLastVisitedAt === undefined ? {} : { lastVisitedAt: serverLastVisitedAt }),
          }}
        />
        <Status thread={remote} />
      </>,
    );
  }
  const label = (environment: string) =>
    container.querySelector(`output[data-environment="${environment}"]`)?.textContent;
  const owner = stack.move();
  return { render, label, [Symbol.asyncDispose]: () => owner.disposeAsync() };
}
it("updates only the visited destination when two environments reuse a thread ID", async () => {
  await using fixture = await setup();
  const { render, label } = fixture;

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
  await using fixture = await setup();
  const { render, label } = fixture;

  useUiStateStore.setState({ threadLastVisitedAtById: { [key(first)]: later } });
  await render(earlier);
  expect(label("first")).toBe("Completed");
  await render(later);
  expect(label("first")).toBe("Read");
});
it("treats an explicit server null as read while omitted tracking uses local visits", async () => {
  await using fixture = await setup();
  const { render, label } = fixture;

  await render(null);
  expect(label("first")).toBe("Read");
  await render();
  expect(label("first")).toBe("Completed");
});
