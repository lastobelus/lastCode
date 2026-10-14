// @vitest-environment happy-dom
import { act } from "react";
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
import { EnvironmentId, RunId, ThreadId, type ActionResumeState } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { LastCodeThreadFamilySummary } from "./LastCodeThreadFamily";
import { LastCodeThreadLeadingControls, LastCodeThreadTitle } from "./LastCodeThreadTitle";
import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import { makeThreadFixture } from "../../test-fixtures";
import { projectLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.logic";
vi.mock("~/hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useClientSetting: (key: string) =>
      useSyncExternalStore(
        (listener) => {
          mocks.settingListeners.add(listener);
          return () => {
            mocks.settingListeners.delete(listener);
          };
        },
        () =>
          key === "compactLegacySidebarStatuses"
            ? mocks.compact
            : key === "lastcodeSidebarFamilyStatusSubheaders"
              ? mocks.subheaders
              : "typed-groups",
      ),
  };
});
vi.mock("../ThreadStatusIndicators", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ThreadStatusIndicators")>();
  return { ThreadStatusLabel: actual.ThreadStatusLabel };
});
vi.mock("../dashboard/ThreadDashboardIndicator", () => ({ ThreadDashboardIndicator: () => null }));
const presentation = {
  isAgentCreated: false,
  creatorDescription: null,
  subagentLabel: null,
  relationshipDescription: null,
  relationshipLabel: null,
  relationshipUnavailableLabel: null,
};
function familyFor(ref: typeof a, title: string) {
  return projectLastCodeSidebarFamilies({
    threads: [makeThreadFixture({ id: ref.threadId, environmentId: ref.environmentId, title })],
    collapsedByKey: {},
    activeThreadKey: null,
    projectExpanded: true,
    previewCount: 5,
    listExpanded: false,
    groupingStyle: "typed-groups",
    statusForThread: () => null,
  }).renderedRows[0]!;
}
import { useLastCodeThreadEditing } from "./useLastCodeThreadEditing";
import { SidebarPresentation } from "./SidebarPresentation";
import { useSidebarModeStore } from "../../sidebarMode";
const mocks = vi.hoisted(() => ({
  update: vi.fn<(value: unknown) => Promise<AtomCommandResult<unknown, unknown>>>(),
  toast: vi.fn(),
  rowDoubleClick: vi.fn(),
  canOperate: true,
  compact: false,
  subheaders: true,
  settingListeners: new Set<() => void>(),
  navigate: vi.fn(async () => {}),
  openPr: vi.fn((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }),
}));
vi.mock("../../state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/threads")>()),
  threadEnvironment: { updateMetadata: "update" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.update,
  ORCHESTRATION_OPERATE_DENIED_MESSAGE: "Read-only environment",
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => mocks.canOperate,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const a = scopeThreadRef(EnvironmentId.make("first-env"), ThreadId.make("same-id"));
const b = scopeThreadRef(EnvironmentId.make("second-env"), ThreadId.make("same-id"));
vi.mock("./LastCodeSidebarPresentation", () => ({
  useLastCodeSidebarPresentation: () => ({
    openPrLink: mocks.openPr,
    openPullRequestsInRightPanel: true,
  }),
}));
function Harness({ revision = 0, pr = false }: { revision?: number; pr?: boolean }) {
  const { renameTarget, archiveTarget, capabilities } = useLastCodeThreadEditing();
  return (
    <div onDoubleClick={mocks.rowDoubleClick}>
      <button onClick={() => capabilities.requestRename(a, "A title")}>Rename A</button>
      <button onClick={() => capabilities.requestRename(b, "B title")}>Rename B</button>
      <button onClick={() => capabilities.requestArchiveConfirmation(b)}>Archive B</button>
      <button onClick={() => capabilities.cancelArchiveConfirmation(a)}>Cancel archive A</button>
      <button onClick={() => capabilities.cancelArchiveConfirmation(b)}>Cancel archive B</button>
      <output>{archiveTarget}</output>
      <span>{revision}</span>
      <LastCodeThreadLeadingControls
        family={familyFor(
          renameTarget?.key === scopedThreadKey(b) ? b : a,
          renameTarget?.key === scopedThreadKey(b) ? "B title" : "A title",
        )}
        presentation={presentation}
        threadStatus={null}
        renameTarget={renameTarget}
        editing={capabilities}
        active={false}
        navigateToThread={mocks.navigate}
        sourceControl={{
          gitCwd: null,
          threadProject: null,
          threadProjectCwd: null,
          branchMismatch: null,
          pr: null,
          prStatus: null,
          currentLinkedPr: pr
            ? {
                host: "github.com",
                repository: "example/project",
                number: 1,
                url: "https://github.com/example/project/pull/1",
                source: "manual",
                linkedAt: "2026-01-01T00:00:00Z",
                snapshot: null,
                stack: null,
              }
            : null,
        }}
      />
    </div>
  );
}
let root: Root | null = null,
  container: HTMLDivElement | null = null;
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
  useSidebarModeStore.setState({ lastcodeHidden: false });
  vi.clearAllMocks();
  mocks.canOperate = true;
  mocks.compact = false;
  mocks.subheaders = true;
  mocks.update.mockResolvedValue(AsyncResult.success(undefined));
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
  const button = [...container!.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(() => button!.click());
}
const input = () => container?.querySelector<HTMLInputElement>("input") ?? null;
async function draft(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(value: string) {
  await act(() =>
    input()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function OutcomeHarness({
  status,
  leading,
  protectedChild = false,
}: {
  status: "failed" | "interrupted";
  leading: ThreadStatusPill["label"] | null;
  protectedChild?: boolean;
}) {
  const { capabilities } = useLastCodeThreadEditing();
  const family = familyFor(a, "Child outcome");
  family.thread = {
    ...family.thread,
    persistent: protectedChild,
    latestRun: {
      runId: RunId.make("child-run"),
      status,
      requestedAt: null,
      startedAt: null,
      completedAt: "2026-01-01T00:01:00Z",
      assistantMessageId: null,
    },
  };
  return (
    <LastCodeThreadTitle
      family={family}
      presentation={{ ...presentation, subagentLabel: "Subagent" }}
      threadStatus={leading ? { label: leading, colorClass: "", dotClass: "", pulse: false } : null}
      renameTarget={null}
      editing={capabilities}
    />
  );
}
describe("mounted family status presentation", () => {
  it("moves a real aggregate from the typed line into an inline compact count", async () => {
    const family = familyFor(a, "Parent with a failed descendant");
    family.descendantCount = 2;
    family.descendantStatusCounts = new Map([
      ["Failed", 1],
      ["Stopped", 1],
    ]);
    family.descendantsStatus = {
      label: "Failed",
      colorClass: "text-red-500",
      dotClass: "bg-red-500",
      pulse: false,
    };
    family.expanded = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() =>
      root?.render(
        <>
          <LastCodeThreadFamilySummary family={family} display="line" />
          <LastCodeThreadFamilySummary family={family} display="inline" />
        </>,
      ),
    );
    expect(container.textContent).toContain("2 subagents");
    expect(container.textContent).not.toContain("+2");
    expect(container.querySelector('[role="img"][aria-label="Failed"]')).not.toBeNull();
    mocks.subheaders = false;
    await act(() => mocks.settingListeners.forEach((listener) => listener()));
    expect(container.textContent).toContain("+2");
    expect(container.textContent).not.toContain("Failed");
    expect(container.textContent).not.toContain("2 subagents");
    expect(container.querySelector('[role="img"][aria-label="Failed"]')).not.toBeNull();
    family.expanded = true;
    await act(() =>
      root?.render(<LastCodeThreadFamilySummary family={{ ...family }} display="inline" />),
    );
    expect(container.textContent).toContain("+2");
    expect(container.textContent).not.toContain("Failed");
    expect(container.querySelector('[role="img"][aria-label="Failed"]')).not.toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
describe("compact child outcomes", () => {
  it.each([
    ["failed", null, "Failed"],
    ["failed", "Completed", "Failed"],
    ["interrupted", null, "Stopped"],
    ["interrupted", "Completed", "Stopped"],
  ] as const)("retains %s when the leading indicator is %s", async (status, leading, label) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => root?.render(<OutcomeHarness status={status} leading={leading} />));
    const outcome = container.querySelector(`[role="img"][aria-label="${label}"]`);
    const marker = outcome?.querySelector("[data-lastcode-sidebar-unscaled-content]") ?? outcome;
    expect(marker?.textContent).toBe(label[0]);
    expect(container.querySelector(`[data-testid="thread-title-${a.threadId}"]`)?.textContent).toBe(
      "Child outcome",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not add a second compact marker for a matching leading outcome", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => root?.render(<OutcomeHarness status="failed" leading="Failed" />));
    expect(container.querySelectorAll('[role="img"][aria-label="Failed"]')).toHaveLength(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["failed", "interrupted"] as const)(
    "keeps %s and protection separately available",
    async (status) => {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(() =>
        root?.render(<OutcomeHarness status={status} leading="Completed" protectedChild />),
      );
      const label = status === "failed" ? "Failed" : "Stopped";
      expect(container.querySelector(`[role="img"][aria-label="${label}"]`)?.textContent).toContain(
        label[0],
      );
      expect(container.querySelector('[role="img"][aria-label="Completed"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Protected"]')).not.toBeNull();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
});
describe("visible status transitions", () => {
  const actionFor = (state: "working" | "waiting", family: ReturnType<typeof familyFor>) =>
    ({
      runId: "fixture-action",
      threadId: family.thread.id,
      projectId: family.thread.projectId,
      actionId: "fixture-check",
      actionName: "Fixture check",
      command: "fixture-check",
      terminalId: "fixture-terminal",
      outcome: "running",
      delivery: "armed",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
      progress: {
        version: 1,
        state,
        summary: "Waiting for fixture",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    }) satisfies ActionResumeState;
  function StatusHarness({ family }: { family: ReturnType<typeof familyFor> }) {
    const { capabilities } = useLastCodeThreadEditing();
    return (
      <LastCodeThreadTitle
        family={family}
        presentation={presentation}
        threadStatus={resolveThreadStatusPill({ thread: family.thread })}
        renameTarget={null}
        editing={capabilities}
      />
    );
  }
  it("keeps Working and the concurrent waiting Action separate, then transitions to Waiting", async () => {
    const family = familyFor(a, "Status transition");
    family.thread = {
      ...family.thread,
      actionResume: actionFor("waiting", family),
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: family.thread.providerInstanceId!,
        providerName: "Fixture provider",
        lastError: null,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => root?.render(<StatusHarness family={family} />));
    expect(container.querySelector('[aria-label="Working"]')?.textContent).toContain("Working");
    expect(container.querySelector('[aria-label^="Waiting for Fixture check."]')).not.toBeNull();
    family.thread = { ...family.thread, runtime: null };
    await act(() => root?.render(<StatusHarness family={family} />));
    expect(container.querySelector('[aria-label="Working"]')).toBeNull();
    expect(container.querySelector('[aria-label="Waiting"]')?.textContent).toContain("Waiting");
    expect(container.querySelector('[aria-label^="Waiting for Fixture check."]')).toBeNull();
    mocks.compact = true;
    await act(() => mocks.settingListeners.forEach((listener) => listener()));
    expect(container.querySelector('[aria-label="Waiting"]')?.textContent).toBe("");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("retains distinct Connecting and Completed labels when a queued run settles", async () => {
    const family = familyFor(a, "Connection transition");
    family.thread = {
      ...family.thread,
      runtime: {
        status: "queued",
        activeRunId: null,
        providerInstanceId: family.thread.providerInstanceId!,
        providerName: "Fixture provider",
        lastError: null,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => root?.render(<StatusHarness family={family} />));
    expect(container.querySelector('[aria-label="Connecting"]')?.textContent).toContain(
      "Connecting",
    );
    family.thread = {
      ...family.thread,
      runtime: null,
      lastVisitedAt: "2026-01-01T00:00:00Z",
      latestRun: {
        runId: RunId.make("fixture-run"),
        status: "completed",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-01-01T00:01:00Z",
        assistantMessageId: null,
      },
    };
    await act(() => root?.render(<StatusHarness family={family} />));
    expect(container.querySelector('[aria-label="Connecting"]')).toBeNull();
    expect(container.querySelector('[aria-label="Completed"]')?.textContent).toContain("Completed");
    expect(container.querySelector(`[data-testid="thread-title-${a.threadId}"]`)?.textContent).toBe(
      "Connection transition",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
describe("row-local rename editor", () => {
  it.each([false, true])(
    "retains the editor draft while respecting another focus owner=%s on mode return",
    async (otherOwnsFocus) => {
      await render();
      await act(() =>
        root?.render(
          <SidebarPresentation visible>
            <Harness />
          </SidebarPresentation>,
        ),
      );
      await click("Rename A");
      await draft("Mode switch draft");
      const editor = input()!;
      useSidebarModeStore.setState({ lastcodeHidden: true });
      await act(() =>
        root?.render(
          <SidebarPresentation visible={false}>
            <Harness />
          </SidebarPresentation>,
        ),
      );
      await act(() => editor.blur());
      expect(mocks.update).not.toHaveBeenCalled();
      const composer = document.createElement("textarea");
      document.body.append(composer);
      if (otherOwnsFocus) composer.focus();
      useSidebarModeStore.setState({ lastcodeHidden: false });
      await act(() =>
        root?.render(
          <SidebarPresentation visible>
            <Harness />
          </SidebarPresentation>,
        ),
      );
      expect(input()).toBe(editor);
      expect(editor.value).toBe("Mode switch draft");
      expect(document.activeElement).toBe(otherOwnsFocus ? composer : editor);
      if (otherOwnsFocus) editor.focus();
      await key("Escape");
      expect(input()).toBeNull();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it("keeps an inline draft mounted when PR presentation changes beside it", async () => {
    await render();
    await click("Rename A");
    await draft("Retained draft");
    const editor = input();
    await act(() => root?.render(<Harness pr />));
    expect(input()).toBe(editor);
    expect(input()?.value).toBe("Retained draft");
    await act(() => container!.querySelector<HTMLAnchorElement>("a")!.click());
    expect(mocks.openPr).toHaveBeenLastCalledWith(
      expect.anything(),
      "https://github.com/example/project/pull/1",
      a,
    );
    expect(mocks.navigate).toHaveBeenCalledWith(a);
    expect(input()).toBe(editor);
    expect(mocks.update).not.toHaveBeenCalled();
    await act(() => root?.render(<Harness />));
    expect(container!.querySelector("a")).toBeNull();
    expect(input()?.value).toBe("Retained draft");
  });
  it("focuses/selects on opening, retains draft through refresh, and isolates double-click word selection", async () => {
    await render();
    await click("Rename A");
    expect(document.activeElement).toBe(input());
    expect(input()?.selectionStart).toBe(0);
    expect(input()?.selectionEnd).toBe("A title".length);
    await draft("Draft");
    mocks.compact = true;
    await act(() => root?.render(<Harness revision={1} />));
    expect(input()?.value).toBe("Draft");
    await act(() => input()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.rowDoubleClick).not.toHaveBeenCalled();
    expect(input()?.value).toBe("Draft");
  });
  it("commits Enter and subsequent blur/repeated Enter only once", async () => {
    const pending = deferred<AtomCommandResult<unknown, unknown>>();
    mocks.update.mockReturnValueOnce(pending.promise);
    await render();
    await click("Rename A");
    await draft("  Changed  ");
    await key("Enter");
    await key("Enter");
    await act(() => input()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: a.environmentId,
      input: { threadId: a.threadId, title: "Changed" },
    });
    await act(async () => {
      pending.resolve(AsyncResult.success(undefined));
      await pending.promise;
    });
    expect(input()).toBeNull();
  });
  it("commits ordinary blur only once and cancels Escape without mutation", async () => {
    await render();
    await click("Rename A");
    await draft("Changed");
    await act(() => input()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(input()).toBeNull();
    await click("Rename B");
    await draft("Cancelled");
    await key("Escape");
    expect(input()).toBeNull();
    expect(mocks.update).toHaveBeenCalledOnce();
  });
  it("finishes empty/unchanged titles without a command and keeps thread-rename failure close semantics", async () => {
    await render();
    await click("Rename A");
    await draft("  ");
    await key("Enter");
    expect(input()).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Thread title cannot be empty" }),
    );
    await click("Rename A");
    await draft(" A title ");
    await key("Enter");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(input()).toBeNull();
    mocks.update.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Denied"))));
    await click("Rename B");
    await draft("Changed");
    await key("Enter");
    expect(input()).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to rename thread" }),
    );
    mocks.toast.mockClear();
    mocks.update.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await click("Rename B");
    await draft("Changed");
    await key("Enter");
    expect(input()).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("does not let completion from A close the newer B session with the same thread ID", async () => {
    const pending = deferred<AtomCommandResult<unknown, unknown>>();
    mocks.update.mockReturnValueOnce(pending.promise);
    await render();
    await click("Rename A");
    await draft("Changed A");
    await key("Enter");
    await click("Rename B");
    await draft("Draft B");
    await act(async () => {
      pending.resolve(AsyncResult.success(undefined));
      await pending.promise;
    });
    expect(input()?.value).toBe("Draft B");
  });
  it("does not let an older A completion close a newly opened A session", async () => {
    const pending = deferred<AtomCommandResult<unknown, unknown>>();
    mocks.update.mockReturnValueOnce(pending.promise);
    await render();
    await click("Rename A");
    await draft("Old");
    await key("Enter");
    await click("Rename A");
    await draft("New session");
    await act(async () => {
      pending.resolve(AsyncResult.success(undefined));
      await pending.promise;
    });
    expect(input()?.value).toBe("New session");
  });
  it("keeps archive and rename independent and compares archive cancellation against the exact row", async () => {
    await render();
    await click("Rename A");
    await draft("Draft");
    await click("Archive B");
    expect(input()?.value).toBe("Draft");
    expect(container?.querySelector("output")?.textContent).toBe(scopedThreadKey(b));
    await click("Cancel archive A");
    expect(container?.querySelector("output")?.textContent).toBe(scopedThreadKey(b));
    await click("Cancel archive B");
    expect(container?.querySelector("output")?.textContent).toBe("");
    expect(input()?.value).toBe("Draft");
  });
  it("does not open a rename session on a read-only destination", async () => {
    await render();
    mocks.canOperate = false;
    await click("Rename A");
    expect(input()).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
