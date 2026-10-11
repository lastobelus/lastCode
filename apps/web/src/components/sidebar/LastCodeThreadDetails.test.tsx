// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { LastCodeThreadMetadata } from "./LastCodeThreadMetadata";
import { LastCodeThreadDetails } from "./LastCodeThreadDetails";
import { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import { LastCodeThreadRowSurface } from "./LastCodeThreadRowSurface";
import { handleLastCodeThreadRowKeyDown } from "./lastcodeThreadRowInteractions";
import { projectLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.logic";
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  context: vi.fn(),
  archive: vi.fn(),
  worktrees: true,
  edit: vi.fn(),
  resolve: vi.fn(),
  save: vi.fn(async () => true),
  permission: vi.fn(() => true),
}));
vi.mock("./lastcodeSidebarPermission", () => ({ checkTaskPermission: mocks.permission }));
const editing = {
  requestRename: vi.fn(),
  finishRename: vi.fn(),
  requestArchiveConfirmation: vi.fn(),
  cancelArchiveConfirmation: vi.fn(),
};
vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: (key: string) =>
    key === "legacySidebarThreadGroupingStyle" ? "typed-groups" : mocks.worktrees,
}));
vi.mock("../ThreadStatusIndicators", () => ({
  ThreadWorktreeIndicator: () => <span>Worktree</span>,
}));
vi.mock("./SidebarEnvironmentIcon", () => ({ ConnectedSidebarEnvironmentIcon: () => null }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
const thread = makeThreadFixture({
  title: "Annotated thread",
  annotation: {
    anchorMessageId: MessageId.make("anchor"),
    body: "Follow up here",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    resolvedAt: null,
  },
});
function Harness({ jump = null, active = true }: { jump?: string | null; active?: boolean }) {
  const lifetime = useLastCodeThreadDetails(
    { environmentId: thread.environmentId, threadId: thread.id },
    editing,
  );
  const { annotationPopoverHandle: handle } = lifetime;
  const value = {
    ...thread,
    annotation: thread.annotation
      ? { ...thread.annotation, resolvedAt: active ? null : "2026-09-04T00:00:00.000Z" }
      : null,
  };
  return (
    <>
      <LastCodeThreadRowSurface
        family={
          projectLastCodeSidebarFamilies({
            threads: [value],
            collapsedByKey: {},
            activeThreadKey: null,
            projectExpanded: true,
            previewCount: 5,
            listExpanded: false,
            groupingStyle: "typed-groups",
          }).renderedItems.flatMap((item) => (item.type === "thread" ? [item.row] : []))[0]!
        }
        relationship={{ relationshipLabel: null, creatorDescription: null }}
        lifetime={lifetime}
        gestures={{
          handleRowClick: mocks.navigate,
          handleRowDoubleClick: () => {},
          handleRowContextMenu: mocks.context,
          handleRowKeyDown: (event) => handleLastCodeThreadRowKeyDown(event, mocks.navigate),
        }}
        active={false}
        selected={false}
        fileDragOver={false}
      >
        <LastCodeThreadMetadata
          thread={value}
          jumpLabel={jump}
          highlighted={false}
          confirming={false}
          canArchive
          annotationHandle={handle}
          environmentIcon={<span data-thread-metadata-column="environment">Remote</span>}
        >
          <button
            onClick={(event) => {
              event.stopPropagation();
              mocks.archive();
            }}
          >
            Archive
          </button>
        </LastCodeThreadMetadata>
      </LastCodeThreadRowSurface>
      <LastCodeThreadDetails
        thread={value}
        lifetime={lifetime}
        gitCwd="/workspace/example"
        content={<div>Thread details</div>}
        trailingContent={<div>Cleanup explanation</div>}
        annotations={{
          onEditAnnotation: mocks.edit,
          onSaveAnnotationBody: mocks.save,
          onResolveAnnotation: mocks.resolve,
        }}
      />
    </>
  );
}
let root: Root | null = null;
let container: HTMLDivElement;
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
afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
  vi.clearAllMocks();
  mocks.permission.mockReturnValue(true);
  root = null;
});
async function render(jump: string | null, active = true) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root?.render(<Harness jump={jump} active={active} />));
}
function trigger() {
  return container.querySelector<HTMLButtonElement>('button[aria-label*="annotation"]')!;
}

function action(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  )!;
}
async function open() {
  await act(() => trigger().click());
}
describe("row details composition", () => {
  it.each(["Enter", " "])(
    "navigates once with %s without opening its annotation, while nested keys stay isolated",
    async (key) => {
      await render(null);
      const row = container.querySelector<HTMLElement>(`[data-testid="thread-row-${thread.id}"]`)!;
      await act(() => {
        row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        row.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
      });
      expect(mocks.navigate).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
      await act(() =>
        action("Archive").dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        ),
      );
      expect(mocks.navigate).toHaveBeenCalledTimes(1);
      await act(() => action("Archive").click());
      expect(mocks.archive).toHaveBeenCalledTimes(1);
      await open();
      expect(document.querySelector('[data-slot="popover-popup"]')?.textContent).toContain(
        "Follow up here",
      );
      expect(container.querySelector(`[data-testid="thread-row-${thread.id}"]`)).toBe(row);
    },
  );
  it("routes a native context-menu key through the same surface and leaves nested controls alone", async () => {
    await render(null);
    const row = container.querySelector<HTMLElement>(`[data-testid="thread-row-${thread.id}"]`)!;
    await act(() =>
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
      ),
    );
    expect(mocks.context).toHaveBeenCalledTimes(1);
    await act(() =>
      action("Archive").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
      ),
    );
    expect(mocks.context).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it.each([null, "⌘1"])(
    "opens annotation from metadata %s with shared content and no navigation",
    async (jump) => {
      await render(jump);
      await open();
      const popup = document.querySelector('[data-slot="popover-popup"]')!;
      expect(popup.textContent).toContain("Follow up here");
      expect(popup.textContent).toContain("Thread details");
      expect(popup.textContent).toContain("Cleanup explanation");
      expect(mocks.navigate).not.toHaveBeenCalled();
      await act(() => action("Resolve").click());
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(thread);
    },
  );
  it("checks the destination permission at edit time after the popup opens", async () => {
    await render(null);
    await open();
    mocks.permission.mockReturnValue(false);
    await act(() => action("Edit").click());
    expect(mocks.permission).toHaveBeenCalledExactlyOnceWith(thread.environmentId);
    expect(mocks.edit).not.toHaveBeenCalled();
    await open();
    mocks.permission.mockReturnValue(true);
    await act(() => action("Edit").click());
    expect(mocks.edit).toHaveBeenCalledExactlyOnceWith(thread);
  });
  it("unmounts a resolved annotation popup and keeps the archive control mounted", async () => {
    await render(null);
    await open();
    const archive = action("Archive");
    await act(() => root?.render(<Harness active={false} />));
    expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
    expect(action("Archive")).toBe(archive);
    expect(trigger()).toBeNull();
  });
});
