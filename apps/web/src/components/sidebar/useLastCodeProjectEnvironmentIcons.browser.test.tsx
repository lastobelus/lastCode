import { act, render, type Screen } from "../../../test/render";
import { useEffect, useState } from "react";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { LastCodeSidebarPresentationProvider } from "./LastCodeSidebarPresentation";
import { useLastCodeProjectEnvironmentIcons } from "./useLastCodeProjectEnvironmentIcons";
const mocks = vi.hoisted(() => ({ primary: "first", open: vi.fn(() => true), badges: vi.fn() }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => mocks.open }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
  useEnvironment: () => null,
  usePrimaryEnvironmentId: () => EnvironmentId.make(mocks.primary),
}));
function member(env: string): SidebarProjectGroupMember {
  return {
    id: ProjectId.make("same-project"),
    environmentId: EnvironmentId.make(env),
    title: env,
    workspaceRoot: `/workspace/${env}`,
    physicalProjectKey: `${env}:physical-key-with:colon`,
    environmentLabel: env,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    scripts: [],
  };
}
const first = member("first"),
  remote = member("remote");
function makeProject(members = [first, remote], key = "group"): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey: key,
    displayName: "Project group",
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: members,
    memberProjectRefs: members.map((value) => scopeProjectRef(value.environmentId, value.id)),
    remoteEnvironmentLabels: ["remote"],
  };
}

const grouped = makeProject();
type Presentation = Omit<ComponentProps<typeof LastCodeSidebarPresentationProvider>, "children">;
const presentation: Presentation = {
  providerEntriesByEnvironmentId: new Map(),
  environmentIconColors: { first: "blue", remote: "red" },
  providerBadgePreferences: { enabled: false, size: 50, transparency: 0 },
  openPullRequestsInRightPanel: false,
  projectEnvironments: {
    desktopLocalEnvironmentIds: new Set(),
    knownEnvironmentIds: new Set([first.environmentId, remote.environmentId]),
    showLocalEnvironmentIcon: false,
  },
};
function Consumer({ project }: { project: SidebarProjectSnapshot }) {
  const badges = useLastCodeProjectEnvironmentIcons(project);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    mocks.badges(badges);
  }, [badges]);
  return (
    <>
      <input
        aria-label="Draft"
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <output>
        {badges.map((badge) => `${badge.label}:${badge.color ?? "default"}`).join(" / ")}
      </output>
    </>
  );
}

async function show(screen: Screen, project = grouped, props = presentation) {
  await act(() =>
    screen.rerender(
      <LastCodeSidebarPresentationProvider {...props}>
        <Consumer project={project} />
      </LastCodeSidebarPresentationProvider>,
    ),
  );
}
it("refreshes known-environment colors while preserving the same editor and stable unchanged badge snapshot", async () => {
  setup();
  await using screen = await render(null);
  const { container } = screen;

  await show(screen);
  const input = container.querySelector("input")!;
  await act(() => {
    input.value = "unsaved";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector("output")?.textContent).toBe("first (local):blue / remote:red");
  await show(screen);
  expect(mocks.badges).toHaveBeenCalledTimes(1);
  await show(screen, grouped, {
    ...presentation,
    projectEnvironments: {
      ...presentation.projectEnvironments,
      knownEnvironmentIds: new Set([first.environmentId]),
    },
  });
  expect(container.querySelector("output")?.textContent).toBe(
    "first (local):blue / remote:default",
  );
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("unsaved");
});
it("applies the local-icon choice to a single member and refreshes the primary environment ordering", async () => {
  setup();
  await using screen = await render(null);
  const { container } = screen;

  const local = makeProject([first]);
  await show(screen, local);
  expect(container.querySelector("output")?.textContent).toBe("");
  await show(screen, local, {
    ...presentation,
    projectEnvironments: { ...presentation.projectEnvironments, showLocalEnvironmentIcon: true },
  });
  expect(container.querySelector("output")?.textContent).toBe("first (local):blue");
  mocks.primary = "remote";
  await show(screen);
  expect(container.querySelector("output")?.textContent).toBe("remote (local):red / first:blue");
});

function setup() {
  vi.clearAllMocks();
  mocks.primary = "first";
}
