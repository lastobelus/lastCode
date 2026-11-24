import { act, fakeTimers, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarProvider } from "../ui/sidebar";
import { LastCodeProjectHeader } from "./LastCodeProjectHeader";

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select?: (settings: ClientSettings) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSetting: (key: string) => (key === "lastcodeStatusIcons" ? {} : 100),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../environmentIcons", () => ({ ConnectedEnvironmentIcon: () => null }));

const member = {
  id: ProjectId.make("sample-project"),
  environmentId: EnvironmentId.make("sample-environment"),
  title: "Sample project",
  workspaceRoot: "/workspace/sample",
  physicalProjectKey: "sample-project",
  environmentLabel: "Sample environment",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};
const project: SidebarProjectSnapshot = {
  ...member,
  projectKey: "sample-project",
  displayName: "Sample project",
  groupedProjectCount: 1,
  environmentPresence: "local-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  memberProjects: [member],
  memberProjectRefs: [scopeProjectRef(member.environmentId, member.id)],
  remoteEnvironmentLabels: [],
  pinned: false,
  archived: false,
};

function Header({ expanded = false }: { expanded?: boolean }) {
  return (
    <SidebarProvider>
      <LastCodeProjectHeader
        project={project}
        expanded={expanded}
        status={null}
        environments={[]}
        latestThreadTimestamp="2026-01-01T00:00:00.000Z"
        drag={{ manual: false, handle: null }}
        gestures={{
          dragInProgressRef: { current: false },
          suppressProjectClickAfterDragRef: { current: false },
          suppressProjectClickForContextMenuRef: { current: false },
        }}
        showMenu={async () => {}}
      >
        {null}
      </LastCodeProjectHeader>
    </SidebarProvider>
  );
}

it("keeps collapsed timestamps current while idle and removes them on expansion", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  // Project headers do not use routes.
  await using screen = await render(<Header />, { router: false });
  expect(screen.container.textContent).toContain("just now");
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.container.textContent).toContain("1m ago");
  await screen.rerender(<Header expanded />);
  expect(screen.container.textContent).not.toContain("1m ago");
});
