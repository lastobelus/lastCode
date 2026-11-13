import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { act, render } from "../../../test/render";
import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import { makeThreadFixture } from "../../test-fixtures";
import { projectLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.logic";
import { LastCodeThreadDetails } from "./LastCodeThreadDetails";
import { LastCodeThreadRowLayout } from "./LastCodeThreadRowLayout";
import { LastCodeThreadRowSurface } from "./LastCodeThreadRowSurface";
import { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import { useLastCodeThreadFileDrop } from "./lastcodeThreadRowInteractions";
import { bindThreadHoverScrollKeys } from "./threadHoverScrollKeys";
import "../../index.css";

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select?: (settings: ClientSettings) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
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

function Harness({
  placement = "right",
  pullRequestCount = 1,
  annotated = false,
}: {
  placement?: "right" | "left";
  pullRequestCount?: number;
  annotated?: boolean;
}) {
  const rowThread = {
    ...thread,
    annotation: annotated
      ? {
          body: "Annotation details",
          createdAt: thread.createdAt,
          updatedAt: thread.createdAt,
          resolvedAt: null,
          anchorMessageId: MessageId.make("annotation-anchor"),
        }
      : null,
  };
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const lifetime = useLastCodeThreadDetails(ref, editing, annotated);
  const { fileDropHandlers } = useLastCodeThreadFileDrop(ref, () => {});
  return (
    <>
      <div
        data-testid="sidebar-scroll"
        style={{
          width: 240,
          height: 120,
          overflowY: "auto",
          marginLeft: placement === "left" ? "calc(100vw - 260px)" : 0,
        }}
      >
        <ul style={{ minHeight: 600 }}>
          <LastCodeThreadRowLayout
            depth={0}
            rowRef={undefined}
            fileDropHandlers={fileDropHandlers}
            annotated={annotated}
            lifetime={lifetime}
          >
            <LastCodeThreadRowSurface
              family={{ ...family, thread: rowThread }}
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
              thread={rowThread}
              lifetime={lifetime}
              gitCwd={null}
              content={
                <div>
                  <span>Thread details</span>
                  <div
                    ref={bindThreadHoverScrollKeys}
                    data-testid="pr-scroll"
                    style={{
                      maxHeight: 140,
                      overflowY: "auto",
                      overscrollBehavior: "contain",
                      paddingLeft: 8,
                    }}
                  >
                    {Array.from({ length: pullRequestCount }, (_, index) => (
                      <a
                        key={index}
                        className="block"
                        href={`https://github.com/example/project/pull/${index + 1}`}
                        onClick={(event) => event.preventDefault()}
                      >
                        PR details{pullRequestCount > 1 ? ` ${index + 1}` : ""}
                      </a>
                    ))}
                  </div>
                </div>
              }
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
      <button style={{ position: "fixed", bottom: 0, right: 0 }}>Outside details</button>
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
  it.each([false, true])(
    "scrolls an annotated=%s PR list with native wheel input and dismisses on exit",
    async (annotated) => {
      await using screen = await render(<Harness pullRequestCount={70} annotated={annotated} />);
      await userEvent.hover(screen.getByTestId(`thread-row-${thread.id}`));
      const scroller = page.getByTestId("pr-scroll");
      await expect.element(scroller).toBeVisible();
      await userEvent.hover(scroller);
      const element = scroller.element() as HTMLElement;
      for (const delta of [100, 200, -100]) {
        const previous = element.scrollTop;
        const scrolled = new Promise<void>((resolve) =>
          element.addEventListener("scroll", () => resolve(), { once: true }),
        );
        await commands.wheel(delta);
        await scrolled;
        expect(element.scrollTop).not.toBe(previous);
      }
      await userEvent.click(scroller, { position: { x: 1, y: 1 } });
      expect(document.activeElement?.matches(":focus-visible")).toBe(false);
      await userEvent.keyboard("{PageDown}");
      await userEvent.hover(screen.getByRole("button", { name: "Outside details" }));
      await expect.element(scroller).not.toBeInTheDocument();
    },
  );

  it.each(["right", "left"] as const)(
    "keeps %s-placed ordinary details open across their shared row edge",
    async (placement) => {
      await using screen = await render(<Harness placement={placement} pullRequestCount={11} />);
      const row = screen.getByTestId(`thread-row-${thread.id}`);
      await userEvent.hover(row);
      const details = page.getByText("Thread details", { exact: true });
      await expect.element(details).toBeVisible();
      await userEvent.hover(details);
      await expect.element(details).toBeVisible();
      const popup = details.element().closest<HTMLElement>('[data-slot="popover-popup"]')!;
      expect(popup.dataset.side).toBe(placement);
      const rowBounds = row.element().getBoundingClientRect();
      const popupBounds = popup.getBoundingClientRect();
      expect(
        Math.abs(
          placement === "right"
            ? popupBounds.left - rowBounds.right
            : rowBounds.left - popupBounds.right,
        ),
      ).toBeLessThan(1);
      await userEvent.hover(row);
      await expect.element(details).toBeVisible();
      await userEvent.hover(details);
      expect(getComputedStyle(details.element()).userSelect).not.toBe("none");
      await userEvent.hover(screen.getByRole("button", { name: "Outside details" }));
      await expect.element(details).not.toBeInTheDocument();
      await userEvent.hover(row);
      await expect.element(details).toBeVisible();
      await userEvent.hover(details);
      await expect.element(details).toBeVisible();
    },
  );

  it("scrubs a 300-row composition without retained cards or duplicate triggers", async () => {
    await using screen = await render(
      <>
        {Array.from({ length: 300 }, (_, index) => (
          <Harness key={index} pullRequestCount={11} />
        ))}
      </>,
    );
    const rows = [...screen.container.querySelectorAll<HTMLLIElement>("li[data-thread-item]")];
    expect(rows).toHaveLength(300);
    expect(screen.container.querySelectorAll("[data-base-ui-click-trigger]")).toHaveLength(300);
    let previous: HTMLLIElement | null = null;
    for (const index of [0, 1, 2, 30, 150, 299, 298, 0]) {
      const row = rows[index]!;
      await act(() => {
        previous?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: row }));
        row.dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, relatedTarget: previous ?? document.body }),
        );
      });
      expect(
        rows.filter((item) => item.querySelector("[data-details-active]")?.textContent === "true"),
      ).toEqual([row]);
      expect(document.querySelectorAll('[data-slot="popover-popup"]')).toHaveLength(1);
      expect(document.querySelectorAll('[data-slot="popover-viewport"]')).toHaveLength(1);
      expect(document.querySelectorAll("[data-previous]")).toHaveLength(0);
      previous = row;
    }
    await act(() =>
      previous!.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      ),
    );
    expect(document.querySelectorAll('[data-slot="popover-popup"]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-base-ui-focus-guard]")).toHaveLength(0);
  });

  it("tabs forward into a previously hovered row without retained focus guards", async () => {
    await using screen = await render(
      <>
        <button>Before row</button>
        <Harness />
      </>,
    );
    const row = screen.getByTestId(`thread-row-${thread.id}`);
    await userEvent.hover(row);
    await expect.element(page.getByText("Thread details", { exact: true })).toBeVisible();
    await userEvent.hover(screen.getByRole("button", { name: "Outside details" }));
    await expect.element(page.getByText("Thread details", { exact: true })).not.toBeInTheDocument();
    await act(() =>
      (screen.getByRole("button", { name: "Before row" }).element() as HTMLElement).focus(),
    );
    await userEvent.tab();
    expect(document.activeElement).toBe(row.element());
  });

  it("dismisses immediately when the pointer leaves for another sidebar row", async () => {
    await using screen = await render(<Harness />);
    await hoverDetails(screen.container);
    await act(() =>
      screen.container.querySelector("li[data-thread-item]")!.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: screen.getByRole("button", { name: "Outside details" }).element(),
        }),
      ),
    );
    expect(screen.container.querySelector("[data-details-active]")?.textContent).toBe("false");
  });

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

  it("preserves popup link focus during ancestor scrolling and returns to the row on Escape", async () => {
    await using screen = await render(<Harness />);
    await userEvent.tab();
    const link = page.getByRole("link", { name: "PR details" });
    await act(() => (link.element() as HTMLElement).focus());
    expect(link.element().matches(":focus-visible")).toBe(true);
    await act(() => {
      const viewport = screen.getByTestId("sidebar-scroll").element();
      viewport.scrollTop = 16;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(link.element()).toBe(document.activeElement);
    expect(screen.container.querySelector("[data-details-active]")?.textContent).toBe("true");
    await userEvent.keyboard("{Escape}");
    await expect.element(link).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId(`thread-row-${thread.id}`).element());
    expect(document.querySelectorAll("[data-base-ui-focus-guard]")).toHaveLength(0);
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
