import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LocalCiSettingsSection } from "./LocalCiSettings";
import { SettingsPageContainer } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

function environment(id: string, supported = true, connected = true) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: connected ? "connected" : "offline" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { capabilities: { lastcodeLocalCi: supported } },
    },
  };
}

const state = vi.hoisted(() => ({
  kind: "all",
  environments: [] as ReturnType<typeof environment>[],
  selected: [] as ReturnType<typeof environment>[],
  update: vi.fn(),
  selectScope: vi.fn(),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironmentId: () => state.environments[0]?.environmentId ?? null,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null && scope === AuthSettingsWriteScope,
  useEnvironmentsWithScope: (
    environments: readonly { environmentId: EnvironmentId }[],
    scope: AuthEnvironmentScope,
  ) =>
    new Set(
      scope === AuthSettingsWriteScope ? environments.map((entry) => entry.environmentId) : [],
    ),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: object) => unknown }) =>
    select({ pathname: "/settings/lastcode", hash: "", state: {} }),
  useNavigate: () => vi.fn(),
}));
vi.mock("./SettingsScopeSentence", () => ({
  SettingsScopeSentence: () => <p>Applying settings for selected scope</p>,
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    scope: { kind: state.kind },
    search: {},
    selectScope: state.selectScope,
    connectedEnvironments: state.selected.filter((entry) => entry.connection.phase === "connected"),
    targets: state.selected
      .filter((entry) => entry.connection.phase === "connected")
      .map((entry) => ({ settings: entry.serverConfig.settings })),
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (selector: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown) =>
    selector(DEFAULT_SERVER_SETTINGS),
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));

function page() {
  return renderToStaticMarkup(
    <SettingsPageContainer>
      <LocalCiSettingsSection />
    </SettingsPageContainer>,
  );
}

beforeEach(() => {
  state.kind = "all";
  state.environments = [environment("managed-server")];
  state.selected = state.environments;
  vi.clearAllMocks();
});

describe("Local CI settings scope", () => {
  it("renders supported controls beneath one page selector", () => {
    const markup = page();
    expect(markup.match(/Applying settings for/g)).toHaveLength(1);
    expect(markup).toContain("Local CI");
    expect(markup).toContain("Quick CI mode");
    expect(markup).toContain("Concurrent CI runs");
  });

  it("keeps an unsupported notice inside the section and offers supporting environments outside the selection", () => {
    state.environments = [
      environment("legacy-server", false),
      environment("managed-server"),
      environment("offline-server", true, false),
    ];
    state.selected = [state.environments[0]!];
    state.kind = "environment";
    const markup = page();
    expect(markup.match(/Applying settings for/g)).toHaveLength(1);
    expect(markup).toContain("Local CI");
    expect(markup).toContain("Update the selected environments");
    expect(markup).toContain("managed-server");
    expect(markup).not.toContain("legacy-server");
    expect(markup).not.toContain("offline-server");
    expect(markup).not.toContain("Quick CI mode");
  });

  it("blocks editing when a connected selected environment is unsupported", () => {
    state.environments.push(environment("legacy-server", false));
    const markup = page();
    expect(markup).toContain("Update the selected environments");
    expect(markup).not.toContain("Quick CI mode");
  });

  it.each(["project", "checkout"])("explains environment ownership at %s scope", (kind) => {
    state.kind = kind;
    const markup = page();
    expect(markup.match(/Applying settings for/g)).toHaveLength(1);
    expect(markup).toContain("Local CI settings apply to all projects on an environment");
    expect(markup).toContain("managed-server");
    expect(markup).not.toContain("Quick CI mode");
  });

  it("offers no offline choices when no supporting environment is connected", () => {
    state.environments = [environment("offline-server", true, false)];
    state.selected = state.environments;
    const markup = page();
    expect(markup.match(/Applying settings for/g)).toHaveLength(1);
    expect(markup).toContain("Update the selected environments");
    expect(markup).not.toContain("offline-server");
    expect(markup).not.toContain("Quick CI mode");
  });

  it("retains the full-page scope selector for standalone recovery notices", () => {
    const markup = renderToStaticMarkup(
      <SettingsScopeNotice target="environment">Choose an environment.</SettingsScopeNotice>,
    );
    expect(markup.match(/Applying settings for/g)).toHaveLength(1);
    expect(markup).toContain("Choose an environment.");
  });
});
