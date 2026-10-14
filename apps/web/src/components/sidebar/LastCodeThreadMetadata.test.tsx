// @vitest-environment happy-dom
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { LastCodeThreadMetadata } from "./LastCodeThreadMetadata";
import { PopoverCreateHandle as createPopoverHandle } from "../ui/popover";
import {
  ThreadAnnotationHoverPopover,
  ThreadAnnotationNavigationTrigger,
} from "../thread-annotation/ThreadAnnotation";
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), archive: vi.fn(), worktrees: true }));
vi.mock("../../hooks/useSettings", () => ({ useClientSetting: () => mocks.worktrees }));
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
  const handle = useMemo(() => createPopoverHandle(), []);
  const value = {
    ...thread,
    annotation: thread.annotation
      ? { ...thread.annotation, resolvedAt: active ? null : "2026-09-04T00:00:00.000Z" }
      : null,
  };
  return (
    <>
      <ThreadAnnotationNavigationTrigger
        annotationActive={active}
        handle={handle}
        id="row-navigation"
        render={<div />}
        role="button"
        tabIndex={0}
        onClick={mocks.navigate}
        onKeyDown={mocks.navigate}
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
      </ThreadAnnotationNavigationTrigger>
      {active && value.annotation ? (
        <ThreadAnnotationHoverPopover
          annotation={value.annotation}
          handle={handle}
          navigationTriggerId="row-navigation"
          threadRef={scopeThreadRef(thread.environmentId, thread.id)}
          threadDetails={<div>Thread details</div>}
          onBodyChange={async () => true}
          onEdit={() => {}}
          onResolve={() => {}}
        />
      ) : null}
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
describe("metadata annotation controls", () => {
  it.each([null, "⌘1"])(
    "opens the same annotation handle from %s without row navigation",
    async (jump) => {
      await render(jump);
      const button = trigger();
      expect(button).not.toBeNull();
      await act(() => {
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      });
      expect(mocks.navigate).not.toHaveBeenCalled();
      await act(() => button.click());
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(document.querySelector('[data-slot="popover-popup"]')?.textContent).toContain(
        "Follow up here",
      );
      expect(document.querySelector('[data-slot="popover-popup"]')?.textContent).toContain(
        "Resolve",
      );
    },
  );
  it("switches jump mode without remounting the archive control or leaving timestamp tracks", async () => {
    await render(null, false);
    const archive = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Archive",
    )!;
    expect(
      container.querySelectorAll(
        '[data-thread-metadata-column="worktree"], [data-thread-metadata-column="environment"]',
      ),
    ).toHaveLength(2);
    await act(() => root?.render(<Harness jump="⌘2" active={false} />));
    expect(
      container.querySelectorAll(
        '[data-thread-metadata-column="worktree"], [data-thread-metadata-column="environment"]',
      ),
    ).toHaveLength(0);
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Archive"),
    ).toBe(archive);
    await act(() => archive.click());
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("⌘2");
    expect(trigger()).toBeNull();
  });
  it.each([null, "⌘3"])(
    "resolves an existing annotation in %s mode without losing ordinary content",
    async (jump) => {
      await render(jump);
      const text = trigger().textContent;
      await act(() => root?.render(<Harness jump={jump} active={false} />));
      expect(trigger()).toBeNull();
      expect(
        container.querySelector('[data-thread-metadata-column="timestamp"]')?.textContent,
      ).toBe(text);
    },
  );
});
