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
