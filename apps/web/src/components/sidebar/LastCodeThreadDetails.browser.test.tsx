import { act, render } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadId, MessageId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { LastCodeThreadMetadata } from "./LastCodeThreadMetadata";
import { LastCodeThreadDetails } from "./LastCodeThreadDetails";
import { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import { LastCodeThreadRowLayout } from "./LastCodeThreadRowLayout";
import { LastCodeThreadRowSurface } from "./LastCodeThreadRowSurface";
import {
  handleLastCodeThreadRowKeyDown,
  useLastCodeThreadFileDrop,
} from "./lastcodeThreadRowInteractions";
import {
  lastcodeSidebarThreadKey,
  projectLastCodeSidebarFamilies,
} from "../lastcodeSidebarFamilies.logic";
const mocks = vi.hoisted(() => ({
  lease: vi.fn(),
  drop: vi.fn(),
  navigate: vi.fn(),
  context: vi.fn(),
  archive: vi.fn(),
  subheaders: true,
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
    key === "lastcodeStatusIcons"
      ? {}
      : key === "legacySidebarThreadGroupingStyle"
        ? "typed-groups"
        : key === "lastcodeSidebarFamilyStatusSubheaders"
          ? mocks.subheaders
          : mocks.worktrees,
}));
vi.mock("../ThreadStatusIndicators", () => ({
  ThreadStatusLabel: () => null,
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
function Harness({
  jump = null,
  active = true,
  withChildren = false,
}: {
  jump?: string | null;
  active?: boolean;
  withChildren?: boolean;
}) {
  const lifetime = useLastCodeThreadDetails(
    { environmentId: thread.environmentId, threadId: thread.id },
    editing,
  );
  const { annotationPopoverHandle: handle } = lifetime;
  const { fileDropHandlers } = useLastCodeThreadFileDrop(
    { environmentId: thread.environmentId, threadId: thread.id },
    mocks.drop,
  );
  const value = {
    ...thread,
    annotation: thread.annotation
      ? { ...thread.annotation, resolvedAt: active ? null : "2026-09-04T00:00:00.000Z" }
      : null,
  };
  return (
    <LastCodeThreadRowLayout
      depth={2}
      rowRef={mocks.lease}
      fileDropHandlers={fileDropHandlers}
      annotated={active}
      lifetime={lifetime}
    >
      <LastCodeThreadRowSurface
        family={
          projectLastCodeSidebarFamilies({
            threads: withChildren
              ? [
                  value,
                  makeThreadFixture({
                    id: ThreadId.make("descendant"),
                    environmentId: value.environmentId,
                    lineage: {
                      rootThreadId: value.id,
                      parentThreadId: value.id,
                      relationshipToParent: "subagent",
                    },
                  }),
                ]
              : [value],
            collapsedByKey: withChildren ? { [lastcodeSidebarThreadKey(value)]: false } : {},
            activeThreadKey: null,
            projectExpanded: true,
            previewCount: 5,
            listExpanded: false,
            groupingStyle: "typed-groups",
          }).renderedItems.flatMap((item) => (item.type === "thread" ? [item.row] : []))[0]!
        }
        relationship={{
          relationshipLabel: withChildren ? "Subagent" : null,
          creatorDescription: null,
        }}
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
      <output data-details-active>{String(lifetime.threadRowActive)}</output>
    </LastCodeThreadRowLayout>
  );
}

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button[aria-label*="annotation"]')!;
}

function action(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  )!;
}
async function open(container: HTMLElement) {
  await act(() => trigger(container).click());
}
function setup() {
  vi.clearAllMocks();
  mocks.permission.mockReturnValue(true);
  mocks.subheaders = true;
  mocks.worktrees = true;
}

describe("row details composition", () => {
  it("announces the expanded compact family summary only while subheaders are off", async () => {
    setup();
    await using screen = await render(<Harness withChildren active={false} />);
    const container = screen.container;
    const row = () => container.querySelector(`[data-testid="thread-row-${thread.id}"]`)!;
    expect(row().getAttribute("aria-label")).not.toContain("1 subagent");
    mocks.subheaders = false;
    await screen.rerender(<Harness withChildren />);
    expect(row().getAttribute("aria-label")).toContain("1 subagent");
    mocks.subheaders = true;
    await screen.rerender(<Harness withChildren active={false} />);
    expect(row().getAttribute("aria-label")).not.toContain("1 subagent");
  });
  it("keeps the lease on the li and cancels confirmation when an unannotated row loses hover", async () => {
    setup();
    await using screen = await render(<Harness jump={null} active={false} />);
    const container = screen.container;
    const li = container.querySelector<HTMLLIElement>("li[data-thread-item]")!;
    expect(mocks.lease).toHaveBeenCalledWith(li);
    const row = container.querySelector<HTMLElement>(`[data-testid="thread-row-${thread.id}"]`)!;
    await act(() => row.focus());
    expect(container.querySelector("output")?.textContent).toBe("true");
    await act(() =>
      li.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null })),
    );
    expect(container.querySelector("output")?.textContent).toBe("false");
    expect(editing.cancelArchiveConfirmation).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
    expect(container.querySelector("li[data-thread-item]")).toBe(li);
  });
  it("leaves annotation activation to the existing trigger when focus and hover enter its row", async () => {
    setup();
    await using screen = await render(<Harness jump={null} active={true} />);
    const container = screen.container;
    const li = container.querySelector<HTMLLIElement>("li[data-thread-item]")!;
    await act(() => {
      container.querySelector<HTMLElement>(`[data-testid="thread-row-${thread.id}"]`)!.focus();
      li.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    expect(container.querySelector("output")?.textContent).toBe("false");
    expect(document.querySelector('[data-slot="popover-popup"]')?.textContent).toContain(
      "Follow up here",
    );
    expect(container.querySelector("li[data-thread-item]")).toBe(li);
  });
  it.each(["Enter", " "])(
    "navigates once with %s without opening its annotation, while nested keys stay isolated",
    async (key) => {
      setup();
      await using screen = await render(<Harness jump={null} active={true} />);
      const container = screen.container;
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
      await open(container);
      expect(document.querySelector('[data-slot="popover-popup"]')?.textContent).toContain(
        "Follow up here",
      );
      expect(container.querySelector(`[data-testid="thread-row-${thread.id}"]`)).toBe(row);
    },
  );
  it("routes a native context-menu key through the same surface and leaves nested controls alone", async () => {
    setup();
    await using screen = await render(<Harness jump={null} active={true} />);
    const container = screen.container;
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
      setup();
      await using screen = await render(<Harness jump={jump} active={true} />);
      const container = screen.container;
      await open(container);
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
    setup();
    await using screen = await render(<Harness jump={null} active={true} />);
    const container = screen.container;
    await open(container);
    mocks.permission.mockReturnValue(false);
    await act(() => action("Edit").click());
    expect(mocks.permission).toHaveBeenCalledExactlyOnceWith(thread.environmentId);
    expect(mocks.edit).not.toHaveBeenCalled();
    await open(container);
    mocks.permission.mockReturnValue(true);
    await act(() => action("Edit").click());
    expect(mocks.edit).toHaveBeenCalledExactlyOnceWith(thread);
  });
  it("unmounts a resolved annotation popup and keeps the archive control mounted", async () => {
    setup();
    await using screen = await render(<Harness jump={null} active={true} />);
    const container = screen.container;
    await open(container);
    const archive = action("Archive");
    await screen.rerender(<Harness active={false} />);
    expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
    expect(action("Archive")).toBe(archive);
    expect(trigger(container)).toBeNull();
  });
});
