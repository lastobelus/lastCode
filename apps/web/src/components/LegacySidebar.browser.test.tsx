import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
} from "../hooks/useSettings";
import { SidebarThreadRow } from "./LegacySidebar";
import "../index.css";

vi.mock("../localApi", () => ({
  readLocalApi: () => null,
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => null,
      setClientSettings: async () => {},
    },
  }),
}));
vi.mock("../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: vi.fn(),
  useAcknowledgeThreadWoke: vi.fn(),
}));
vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: vi.fn(),
  useHandleNewThread: vi.fn(),
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeFooter: () => null,
  SidebarChromeHeader: () => null,
}));
vi.mock("./WorktreeCleanupFailureDialog", () => ({ WorktreeCleanupFailureDialog: () => null }));

function setup() {
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, compactLegacySidebarStatuses: false });
  return { [Symbol.dispose]: __resetClientSettingsPersistenceForTests };
}

function row() {
  return (
    <ul>
      <SidebarThreadRow
        thread={makeThreadFixture({ title: "Native question", hasPendingUserInput: true })}
        orderedProjectThreadKeys={[]}
        isActive={false}
        openPullRequestsInRightPanel={false}
        jumpLabel={null}
        appSettingsConfirmThreadArchive={false}
        renamingThreadKey={null}
        renamingTitle=""
        setRenamingTitle={vi.fn()}
        startThreadRename={vi.fn()}
        renamingInputRef={{ current: null }}
        renamingCommittedRef={{ current: false }}
        confirmingArchiveThreadKey={null}
        setConfirmingArchiveThreadKey={vi.fn()}
        confirmArchiveButtonRefs={{ current: new Map() }}
        handleThreadClick={vi.fn()}
        navigateToThread={vi.fn(async () => {})}
        handleMultiSelectContextMenu={vi.fn(async () => {})}
        handleThreadContextMenu={vi.fn(async () => {})}
        clearSelection={vi.fn()}
        commitRename={vi.fn(async () => {})}
        cancelRename={vi.fn()}
        attemptArchiveThread={vi.fn(async () => {})}
        openPrLink={vi.fn(() => false)}
        onFileDropThreads={vi.fn()}
      />
    </ul>
  );
}

it("updates an ordinary legacy row when compact status indicators change", async () => {
  using _settings = setup();
  await using screen = await render(row());
  const marker = () => screen.container.querySelector<HTMLElement>('[aria-label="Awaiting Input"]');
  await vi.waitFor(() => expect(marker()?.textContent).toBe("Awaiting Input"));
  await act(async () => {
    await updateClientSettings({ compactLegacySidebarStatuses: true });
  });
  await vi.waitFor(() => {
    expect(marker()?.textContent).toBe("");
    expect(marker()?.getBoundingClientRect().width).toBe(14);
    expect(marker()?.getBoundingClientRect().height).toBe(14);
    expect(screen.container.textContent).toContain("Native question");
  });
  await act(async () => {
    await updateClientSettings({ compactLegacySidebarStatuses: false });
  });
  await vi.waitFor(() => expect(marker()?.textContent).toBe("Awaiting Input"));
});

it("keeps a native input request's chosen shape and fill in compact and labeled legacy rows", async () => {
  using _settings = setup();
  await updateClientSettings({
    compactLegacySidebarStatuses: true,
    lastcodeStatusIcons: { "Awaiting Input": { shape: "triangle-right", style: "outline-fill" } },
  });
  await using screen = await render(row());
  const marker = () => screen.container.querySelector<HTMLElement>('[aria-label="Awaiting Input"]');
  const glyph = () => marker()?.querySelector<HTMLElement>("[data-status-shape]");
  await vi.waitFor(() => {
    expect(marker()?.textContent).toBe("");
    expect(marker()?.getBoundingClientRect().width).toBe(14);
    expect(glyph()?.dataset.statusShape).toBe("triangle-right");
    expect(glyph()?.dataset.statusStyle).toBe("outline-fill");
    const paint = glyph()?.firstElementChild;
    if (!(paint instanceof HTMLElement)) throw new Error("The status must paint its glyph.");
    const svg = decodeURIComponent(getComputedStyle(paint).maskImage);
    expect(svg).toContain("rotate(90 3 3)");
    expect(svg).toContain('fill-opacity="0.5" stroke="black" stroke-width="1"');
    expect(paint.classList.contains("bg-indigo-500")).toBe(true);
  });
  await act(async () => {
    await updateClientSettings({ compactLegacySidebarStatuses: false });
  });
  await vi.waitFor(() => {
    expect(marker()?.textContent).toBe("Awaiting Input");
    expect(glyph()?.dataset.statusShape).toBe("triangle-right");
    expect(glyph()?.dataset.statusStyle).toBe("outline-fill");
  });
  await act(async () => {
    await updateClientSettings({ lastcodeStatusIcons: {} });
  });
  await vi.waitFor(() => {
    expect(glyph()?.dataset.statusShape).toBe("circle");
    expect(glyph()?.dataset.statusStyle).toBe("solid");
  });
});
