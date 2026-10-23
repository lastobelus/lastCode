import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { makeThreadFixture } from "../../test-fixtures";
import { projectLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.logic";
import { LastCodeThreadDetails } from "./LastCodeThreadDetails";
import { LastCodeThreadRowLayout } from "./LastCodeThreadRowLayout";
import { LastCodeThreadRowSurface } from "./LastCodeThreadRowSurface";
import { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import { useLastCodeThreadFileDrop } from "./lastcodeThreadRowInteractions";

vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: (key: string) =>
    key === "legacySidebarThreadGroupingStyle" ? "minimal" : false,
}));
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("../ThreadStatusIndicators", () => ({
  ThreadStatusLabel: () => null,
  ThreadWorktreeIndicator: () => null,
}));

const thread = makeThreadFixture({ title: "Hover details", annotation: null });
const family = projectLastCodeSidebarFamilies({
  threads: [thread],
  collapsedByKey: {},
  activeThreadKey: null,
  projectExpanded: true,
  previewCount: 5,
  listExpanded: false,
  groupingStyle: "minimal",
}).renderedItems.flatMap((item) => (item.type === "thread" ? [item.row] : []))[0]!;
const editing = {
  requestRename: () => {},
  finishRename: () => {},
  requestArchiveConfirmation: () => {},
  cancelArchiveConfirmation: () => {},
};

function Harness() {
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const lifetime = useLastCodeThreadDetails(ref, editing);
  const { fileDropHandlers } = useLastCodeThreadFileDrop(ref, () => {});
  return (
    <>
      <div data-testid="sidebar-scroll" style={{ height: 120, overflowY: "auto" }}>
        <ul style={{ minHeight: 600 }}>
          <LastCodeThreadRowLayout
            depth={0}
            rowRef={undefined}
            fileDropHandlers={fileDropHandlers}
            annotated={false}
            lifetime={lifetime}
          >
            <LastCodeThreadRowSurface
              family={family}
              relationship={{ relationshipLabel: null, creatorDescription: null }}
              lifetime={lifetime}
              gestures={{
                handleRowClick: () => {},
                handleRowDoubleClick: () => {},
                handleRowKeyDown: () => {},
                handleRowContextMenu: () => {},
              }}
              active={false}
              selected={false}
              fileDragOver={false}
            >
              <button data-testid="row-control" onClick={(event) => event.stopPropagation()}>
                Row control
              </button>
            </LastCodeThreadRowSurface>
            <LastCodeThreadDetails
              thread={thread}
              lifetime={lifetime}
              gitCwd={null}
              content={<div>Thread details</div>}
              trailingContent={null}
              annotations={{
                onEditAnnotation: () => {},
                onSaveAnnotationBody: async () => true,
                onResolveAnnotation: () => {},
              }}
            />
            <output data-details-active>{String(lifetime.threadRowActive)}</output>
          </LastCodeThreadRowLayout>
        </ul>
      </div>
      <div data-testid="unrelated-scroll" style={{ height: 120, overflowY: "auto" }}>
        <div style={{ height: 600 }}>Another pane</div>
      </div>
      <button>Outside details</button>
    </>
  );
}

async function hoverDetails(container: HTMLElement) {
  // Keep focus outside the row: blur must not hide a missing hover dismissal.
  await act(() =>
    container
      .querySelector("li[data-thread-item]")!
      .dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })),
  );
  await expect.element(page.getByText("Thread details", { exact: true })).toBeVisible();
  expect(container.querySelector("[data-details-active]")?.textContent).toBe("true");
}

describe("thread hover dismissal", () => {
  it.each(["hovered", "pointer-focused"])(
    "dismisses a %s card when its ancestor scrolls without pointer exit",
    async (activation) => {
      await using screen = await render(<Harness />);
      const viewport = screen.getByTestId("sidebar-scroll").element();
      await hoverDetails(screen.container);
      if (activation === "pointer-focused") {
        const control = screen.getByTestId("row-control");
        await userEvent.click(control);
        expect(control.element().matches(":focus-visible")).toBe(false);
      }
      await act(() => {
        viewport.scrollTop = 16;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(viewport.scrollTop).toBe(16);
      await expect
        .element(screen.container.querySelector<HTMLOutputElement>("[data-details-active]")!)
        .toHaveTextContent("false");
      await expect
        .element(page.getByText("Thread details", { exact: true }))
        .not.toBeInTheDocument();
    },
  );

  it("keeps an already-open hover card active when an unrelated pane scrolls", async () => {
    await using screen = await render(<Harness />);
    await hoverDetails(screen.container);
    const viewport = screen.getByTestId("unrelated-scroll").element();
    await act(() => {
      viewport.scrollTop = 16;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(viewport.scrollTop).toBe(16);
    expect(screen.container.querySelector("[data-details-active]")?.textContent).toBe("true");
    await expect.element(page.getByText("Thread details", { exact: true })).toBeVisible();
  });

  it("keeps keyboard-focused details open when the sidebar scrolls the row into view", async () => {
    await using screen = await render(<Harness />);
    await userEvent.tab();
    const row = screen.getByTestId(`thread-row-${thread.id}`).element();
    expect(row.matches(":focus-visible")).toBe(true);
    await expect.element(page.getByText("Thread details", { exact: true })).toBeVisible();
    await act(() => {
      const viewport = screen.getByTestId("sidebar-scroll").element();
      viewport.scrollTop = 16;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(row.hasAttribute("aria-describedby")).toBe(true);
    await expect.element(page.getByText("Thread details", { exact: true })).toBeVisible();
  });

  it("keeps details open when pressing an already-focused control inside the row", async () => {
    await using screen = await render(<Harness />);
    await hoverDetails(screen.container);
    const control = screen.getByTestId("row-control");
    await userEvent.click(control);
    await expect.element(page.getByText("Thread details", { exact: true })).toBeVisible();
    await userEvent.click(control);
    await expect.element(page.getByText("Thread details", { exact: true })).toBeVisible();
  });

  it("honors an outside click dismissal from the mounted details tooltip", async () => {
    await using screen = await render(<Harness />);
    await hoverDetails(screen.container);
    await userEvent.click(screen.getByRole("button", { name: "Outside details" }));
    await expect
      .element(screen.container.querySelector<HTMLOutputElement>("[data-details-active]")!)
      .toHaveTextContent("false");
    await expect.element(page.getByText("Thread details", { exact: true })).not.toBeInTheDocument();
  });
});
