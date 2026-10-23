import { render } from "../../../test/render";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
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
function Consumer({
  onValue,
}: {
  onValue: (value: ReturnType<typeof useLastCodeSidebarEnvironments>) => void;
}) {
  const metadata = useLastCodeSidebarEnvironments();
  useEffect(() => onValue(metadata), [metadata, onValue]);
  return <output>{[...metadata.grouping.environmentLabelById.values()].join(",")}</output>;
}
async function renderEnvironments() {
  let current!: ReturnType<typeof useLastCodeSidebarEnvironments>;
  const onValue = (value: typeof current) => {
    current = value;
  };
  const screen = await render(<Consumer onValue={onValue} />, { router: false });
  return Object.assign(screen, {
    value: () => current,
    refresh: () => screen.rerender(<Consumer onValue={onValue} />),
  });
}
function setup() {
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
}
it("uses fallback only for the primary environment and respects an explicit empty catalog", async () => {
  setup();
  await using screen = await renderEnvironments();
  const catalogs = screen.value().presentation.providerEntriesByEnvironmentId;
  expect([...catalogs.get("first")!.keys()]).toEqual(["fallback"]);
  expect(catalogs.get("remote")!.size).toBe(0);
  mocks.environments = [environment("first"), environment("remote")];
  mocks.providersByEnvironment = new Map([
    [EnvironmentId.make("first"), []],
    [EnvironmentId.make("remote"), [provider("own")]],
  ]);
  await screen.refresh();
  expect(screen.value().presentation.providerEntriesByEnvironmentId.get("first")!.size).toBe(0);
  expect([
    ...screen.value().presentation.providerEntriesByEnvironmentId.get("remote")!.keys(),
  ]).toEqual(["own"]);
});
it("keeps scoped scratch roots and labels with desktop-local and WSL classifications", async () => {
  setup();
  mocks.environments = [
    ...mocks.environments,
    environment("scratch", "scratch", {
      scratchWorkspaceRoot: "/workspace/scratch",
    }),
    environment("empty", "empty", { scratchWorkspaceRoot: "" }),
  ];
  await using screen = await renderEnvironments();
  expect([...screen.value().grouping.scratchWorkspaceRootsByEnvironmentId]).toEqual([
    ["scratch", "/workspace/scratch"],
  ]);
  expect([...screen.value().grouping.desktopLocalEnvironmentIds]).toEqual(["desktop", "wsl"]);
  expect([...screen.value().grouping.wslEnvironmentIds]).toEqual(["wsl"]);
  expect([...screen.value().presentation.projectEnvironments.knownEnvironmentIds]).toEqual([
    "first",
    "remote",
    "desktop",
    "wsl",
    "scratch",
    "empty",
  ]);
  expect(screen.value().grouping.environmentLabelById.get(EnvironmentId.make("scratch"))).toBe(
    "scratch",
  );
  expect(screen.container.textContent).toContain("scratch");
});
it("retains grouping identity on presentation-only settings and provider refreshes", async () => {
  setup();
  await using screen = await renderEnvironments();
  const before = screen.value();
  await screen.refresh();
  expect(screen.value().grouping).toBe(before.grouping);
  expect(screen.value().presentation).toBe(before.presentation);
  mocks.settings = { environmentIconColors: { remote: "red" }, showLocalEnvironmentIcon: true };
  await screen.refresh();
  expect(screen.value().grouping).toBe(before.grouping);
  expect(screen.value().presentation.projectEnvironments.showLocalEnvironmentIcon).toBe(true);
  expect(screen.value().presentation.providerEntriesByEnvironmentId).toBe(
    before.presentation.providerEntriesByEnvironmentId,
  );
  const icons = screen.value().presentation.projectEnvironments;
  mocks.providers = [provider("replacement")];
  await screen.refresh();
  expect(screen.value().grouping).toBe(before.grouping);
  expect(screen.value().presentation.projectEnvironments).toBe(icons);
  expect([
    ...screen.value().presentation.providerEntriesByEnvironmentId.get("first")!.keys(),
  ]).toEqual(["replacement"]);
});
it("refreshes exact labels, roots and fallback ownership when the environment snapshot changes", async () => {
  setup();
  await using screen = await renderEnvironments();
  const before = screen.value();
  mocks.primary = "remote";
  mocks.environments = [
    environment("remote", "remote", {
      scratchWorkspaceRoot: "/workspace/new",
    }),
  ];
  mocks.providersByEnvironment = new Map([[EnvironmentId.make("remote"), [provider("new")]]]);
  mocks.environments[0]!.label = "Renamed";
  await screen.refresh();
  expect(screen.value().grouping).not.toBe(before.grouping);
  expect(screen.value().grouping.primaryEnvironmentId).toBe("remote");
  expect(screen.container.textContent).toBe("Renamed");
  expect([...screen.value().grouping.scratchWorkspaceRootsByEnvironmentId]).toEqual([
    ["remote", "/workspace/new"],
  ]);
  expect(screen.value().presentation.providerEntriesByEnvironmentId.has("first")).toBe(false);
  expect([
    ...screen.value().presentation.providerEntriesByEnvironmentId.get("remote")!.keys(),
  ]).toEqual(["new"]);
});
