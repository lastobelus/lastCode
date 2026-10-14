// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { RunId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";
const mocks = vi.hoisted(() => ({
  tracking: true,
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  failed: false,
  calls: [] as Array<{ kind: string; input: { threadId: string; visitedAt?: string } }>,
  toast: vi.fn(),
  unsupportedIds: new Set<string>(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readThreadShell: (target: { threadId: string }) =>
    mocks.thread && {
      ...mocks.thread,
      id: target.threadId,
      latestRun: mocks.unsupportedIds.has(target.threadId) ? null : mocks.thread.latestRun,
    },
  readEnvironmentSupportsVisitedTracking: () => mocks.tracking,
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (command: unknown, options?: { reportFailure?: boolean }) =>
    async (payload: { environmentId: string; input: { threadId: string; visitedAt?: string } }) => {
      const { threadEnvironment } = await import("../state/threads");
      const kind = command === threadEnvironment.visit ? "visit" : "unread";
      mocks.calls.push({ kind, input: payload.input });
      if (mocks.failed) return AsyncResult.failure(Cause.fail(new Error("Connection unavailable")));
      if (!mocks.thread) return AsyncResult.success(undefined);
      const stamp =
        kind === "visit"
          ? payload.input.visitedAt!
          : new Date(Date.parse(mocks.thread.latestRun!.completedAt!) - 1).toISOString();
      mocks.thread = { ...mocks.thread, lastVisitedAt: stamp };
      return AsyncResult.success(undefined);
    },
}));
import { useMarkThreadRead, useMarkThreadUnread } from "./useThreadActions";
import { markThreadsReadState } from "./threadReadActions";
let root: Root, container: HTMLDivElement;
const initial = makeThreadFixture({
  updatedAt: "2026-01-01T00:01:00Z",
  lastVisitedAt: "2026-01-01T00:02:00Z",
  latestRun: {
    runId: RunId.make("done"),
    status: "completed",
    requestedAt: null,
    startedAt: null,
    completedAt: "2026-01-01T00:01:00Z",
    assistantMessageId: null,
  },
});
const ref = scopeThreadRef(initial.environmentId, initial.id),
  key = scopedThreadKey(ref);
const bulkRefs = [
  ref,
  scopeThreadRef(initial.environmentId, ThreadId.make("second")),
  scopeThreadRef(initial.environmentId, ThreadId.make("third")),
];
function Harness() {
  const read = useMarkThreadRead(),
    unread = useMarkThreadUnread();
  return (
    <>
      <button onClick={() => unread(ref)}>Mark unread</button>
      <button onClick={() => read(ref)}>Mark read</button>
      <button onClick={() => markThreadsReadState(bulkRefs, unread)}>Bulk unread</button>
      <button onClick={() => markThreadsReadState(bulkRefs, read)}>Bulk read</button>
    </>
  );
}
const action = async (label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")].find((x) => x.textContent === label)!.click();
  });
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.tracking = true;
  mocks.failed = false;
  mocks.thread = initial;
  mocks.calls = [];
  mocks.toast.mockClear();
  mocks.unsupportedIds.clear();
  useUiStateStore.setState({ threadLastVisitedAtById: { [key]: initial.lastVisitedAt! } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Harness />));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(() => root.unmount());
  container.remove();
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
});
describe("explicit read-state actions", () => {
  it("marks supported bulk targets while counting only unsupported ones", async () => {
    mocks.unsupportedIds.add(bulkRefs[1]!.threadId);
    await action("Bulk unread");
    expect(mocks.calls.map((x) => x.input.threadId)).toEqual([ref.threadId, bulkRefs[2]!.threadId]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "1 of 3 threads have no completed reply yet." }),
    );
  });
  it.each(["Bulk unread", "Bulk read"])(
    "reports rejected %s once for distinct targets",
    async (label) => {
      mocks.failed = true;
      mocks.thread = { ...initial, lastVisitedAt: null };
      useUiStateStore.setState({ threadLastVisitedAtById: {} });
      await action(label);
      expect(mocks.calls.map((x) => x.input.threadId)).toEqual(bulkRefs.map((x) => x.threadId));
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Read markers could not be saved",
          description: "3 of 3 read markers could not be saved. Reconnect and try again.",
        }),
      );
    },
  );
  it.each([true, false])(
    "skips already-acknowledged read markers with tracking=%s",
    async (tracking) => {
      mocks.tracking = tracking;
      await action("Mark unread");
      await action("Mark read");
      const calls = [...mocks.calls];
      const state = useUiStateStore.getState();
      await action("Mark read");
      expect(mocks.calls).toEqual(calls);
      expect(useUiStateStore.getState()).toBe(state);
    },
  );
  it("reports unsupported bulk targets once", async () => {
    mocks.thread = { ...initial, latestRun: null };
    await action("Bulk unread");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "3 of 3 threads have no completed reply yet." }),
    );
    expect(mocks.calls).toEqual([]);
  });
  it.each([true, false])(
    "does not acknowledge future replies using a fast client clock, tracking=%s",
    async (tracking) => {
      mocks.tracking = tracking;
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:10:00Z"));
      mocks.thread = { ...initial, lastVisitedAt: "2026-01-01T00:00:00Z" };
      useUiStateStore.setState({ threadLastVisitedAtById: { [key]: "2026-01-01T00:00:00Z" } });
      await action("Mark read");
      const watermark = tracking
        ? mocks.thread!.lastVisitedAt
        : useUiStateStore.getState().threadLastVisitedAtById[key];
      expect(Date.parse(watermark!)).toBe(Date.parse(initial.updatedAt));
      const laterCompletion = "2026-01-01T00:02:00Z";
      mocks.thread = {
        ...mocks.thread!,
        updatedAt: laterCompletion,
        latestRun: { ...initial.latestRun!, completedAt: laterCompletion },
      };
      expect(Date.parse(mocks.thread.latestRun!.completedAt!)).toBeGreaterThan(
        Date.parse(watermark!),
      );
    },
  );
  it.each([true, false])(
    "supports read→unread→read with visited tracking=%s without a new reply",
    async (tracking) => {
      mocks.tracking = tracking;
      await action("Mark unread");
      const unread = tracking
        ? mocks.thread!.lastVisitedAt
        : useUiStateStore.getState().threadLastVisitedAtById[key];
      expect(Date.parse(unread!)).toBe(Date.parse(initial.latestRun!.completedAt!) - 1);
      await action("Mark read");
      const read = tracking
        ? mocks.thread!.lastVisitedAt
        : useUiStateStore.getState().threadLastVisitedAtById[key];
      expect(Date.parse(read!)).toBeGreaterThanOrEqual(Date.parse(initial.updatedAt));
      expect(mocks.thread!.latestRun).toEqual(initial.latestRun);
      expect(mocks.calls.map((x) => x.kind)).toEqual(tracking ? ["unread", "visit"] : []);
    },
  );
  it.each([true, false])(
    "reports no completed reply instead of silently failing with tracking=%s",
    async (tracking) => {
      mocks.tracking = tracking;
      mocks.thread = { ...initial, latestRun: null };
      await action("Mark unread");
      expect(mocks.calls).toEqual([]);
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Nothing to mark unread" }),
      );
      expect(useUiStateStore.getState().threadLastVisitedAtById[key]).toBe(initial.lastVisitedAt);
    },
  );
  it.each(["Mark unread", "Mark read"])(
    "reports rejected %s and leaves the existing marker intact",
    async (label) => {
      mocks.failed = true;
      if (label === "Mark read") {
        mocks.thread = { ...initial, lastVisitedAt: null };
        useUiStateStore.setState({ threadLastVisitedAtById: {} });
      }
      await action(label);
      expect(mocks.thread!.lastVisitedAt).toBe(
        label === "Mark read" ? null : initial.lastVisitedAt,
      );
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Read marker could not be saved" }),
      );
    },
  );
  it("reads the newest completion at activation, and Mark read works with no completion", async () => {
    mocks.thread = {
      ...initial,
      latestRun: { ...initial.latestRun!, completedAt: "2026-01-01T00:05:00Z" },
    };
    await action("Mark unread");
    expect(mocks.thread!.lastVisitedAt).toBe("2026-01-01T00:04:59.999Z");
    mocks.thread = { ...mocks.thread!, latestRun: null, lastVisitedAt: null };
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
    await action("Mark read");
    expect(mocks.calls.at(-1)?.kind).toBe("visit");
  });
});
