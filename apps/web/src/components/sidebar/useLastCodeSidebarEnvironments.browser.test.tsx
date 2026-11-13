import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useLastCodeSidebarEnvironments } from "./useLastCodeSidebarEnvironments";
const mocks = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    label: string;
    entry: { target: { _tag: "BearerConnectionTarget"; connectionId: string } };
    serverConfig: { scratchWorkspaceRoot?: string } | null;
  }>,
  primary: "first",
  providers: [] as ServerProvider[],
  providersByEnvironment: new Map<EnvironmentId, readonly ServerProvider[]>(),
  settings: { environmentIconColors: {}, showLocalEnvironmentIcon: false },
  badges: { enabled: true, size: 50, transparency: 0 },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
  useEnvironmentProviders: () => mocks.providersByEnvironment,
  usePrimaryEnvironmentId: () => mocks.primary,
}));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.providers }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: typeof mocks.settings) => unknown) =>
    selector(mocks.settings),
}));
vi.mock("./SidebarEnvironmentIcon", () => ({
  useSidebarProviderBadgePreferences: () => mocks.badges,
}));
function provider(id: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}
function environment(
  id: string,
  connectionId = id,
  serverConfig: (typeof mocks.environments)[number]["serverConfig"] = null,
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    entry: { target: { _tag: "BearerConnectionTarget" as const, connectionId } },
    serverConfig,
  };
}
let root: Root, container: HTMLDivElement;
let current: ReturnType<typeof useLastCodeSidebarEnvironments>;
function Consumer() {
  const metadata = useLastCodeSidebarEnvironments();
  useEffect(() => {
    current = metadata;
  }, [metadata]);
  return <output>{[...metadata.grouping.environmentLabelById.values()].join(",")}</output>;
}
async function render() {
  await act(() => root.render(<Consumer />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.primary = "first";
  mocks.providersByEnvironment = new Map();
  mocks.providers = [provider("fallback")];
  mocks.environments = [
    environment("first"),
    environment("remote"),
    environment("desktop", "local:linux"),
    environment("wsl", "local:wsl:example"),
  ];
  mocks.settings = { environmentIconColors: {}, showLocalEnvironmentIcon: false };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("uses fallback only for the primary environment and respects an explicit empty catalog", async () => {
  await render();
  const catalogs = current.presentation.providerEntriesByEnvironmentId;
  expect([...catalogs.get("first")!.keys()]).toEqual(["fallback"]);
  expect(catalogs.get("remote")!.size).toBe(0);
  mocks.environments = [environment("first"), environment("remote")];
  mocks.providersByEnvironment = new Map([
    [EnvironmentId.make("first"), []],
    [EnvironmentId.make("remote"), [provider("own")]],
  ]);
  await render();
  expect(current.presentation.providerEntriesByEnvironmentId.get("first")!.size).toBe(0);
  expect([...current.presentation.providerEntriesByEnvironmentId.get("remote")!.keys()]).toEqual([
    "own",
  ]);
});
it("keeps scoped scratch roots and labels with desktop-local and WSL classifications", async () => {
  mocks.environments = [
    ...mocks.environments,
    environment("scratch", "scratch", {
      scratchWorkspaceRoot: "/workspace/scratch",
    }),
    environment("empty", "empty", { scratchWorkspaceRoot: "" }),
  ];
  await render();
  expect([...current.grouping.scratchWorkspaceRootsByEnvironmentId]).toEqual([
    ["scratch", "/workspace/scratch"],
  ]);
  expect([...current.grouping.desktopLocalEnvironmentIds]).toEqual(["desktop", "wsl"]);
  expect([...current.grouping.wslEnvironmentIds]).toEqual(["wsl"]);
  expect([...current.presentation.projectEnvironments.knownEnvironmentIds]).toEqual([
    "first",
    "remote",
    "desktop",
    "wsl",
    "scratch",
    "empty",
  ]);
  expect(current.grouping.environmentLabelById.get(EnvironmentId.make("scratch"))).toBe("scratch");
  expect(container.textContent).toContain("scratch");
});
it("retains grouping identity on presentation-only settings and provider refreshes", async () => {
  await render();
  const before = current;
  await render();
  expect(current.grouping).toBe(before.grouping);
  expect(current.presentation).toBe(before.presentation);
  mocks.settings = { environmentIconColors: { remote: "red" }, showLocalEnvironmentIcon: true };
  await render();
  expect(current.grouping).toBe(before.grouping);
  expect(current.presentation.projectEnvironments.showLocalEnvironmentIcon).toBe(true);
  expect(current.presentation.providerEntriesByEnvironmentId).toBe(
    before.presentation.providerEntriesByEnvironmentId,
  );
  const icons = current.presentation.projectEnvironments;
  mocks.providers = [provider("replacement")];
  await render();
  expect(current.grouping).toBe(before.grouping);
  expect(current.presentation.projectEnvironments).toBe(icons);
  expect([...current.presentation.providerEntriesByEnvironmentId.get("first")!.keys()]).toEqual([
    "replacement",
  ]);
});
it("refreshes exact labels, roots and fallback ownership when the environment snapshot changes", async () => {
  await render();
  const before = current;
  mocks.primary = "remote";
  mocks.environments = [
    environment("remote", "remote", {
      scratchWorkspaceRoot: "/workspace/new",
    }),
  ];
  mocks.providersByEnvironment = new Map([[EnvironmentId.make("remote"), [provider("new")]]]);
  mocks.environments[0]!.label = "Renamed";
  await render();
  expect(current.grouping).not.toBe(before.grouping);
  expect(current.grouping.primaryEnvironmentId).toBe("remote");
  expect(container.textContent).toBe("Renamed");
  expect([...current.grouping.scratchWorkspaceRootsByEnvironmentId]).toEqual([
    ["remote", "/workspace/new"],
  ]);
  expect(current.presentation.providerEntriesByEnvironmentId.has("first")).toBe(false);
  expect([...current.presentation.providerEntriesByEnvironmentId.get("remote")!.keys()]).toEqual([
    "new",
  ]);
});
