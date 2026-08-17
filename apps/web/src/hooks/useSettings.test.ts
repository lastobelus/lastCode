import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const localApiMocks = vi.hoisted(() => ({
  setClientSettings: vi.fn(async (_settings: ClientSettings) => {}),
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setClientSettings: localApiMocks.setClientSettings,
    },
  }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
  updateClientSettings,
} from "./useSettings";

afterEach(() => {
  localApiMocks.setClientSettings.mockReset();
  localApiMocks.setClientSettings.mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});

describe("updateClientSettings", () => {
  it("applies repeated functional updates and persists them in invocation order", async () => {
    const writes: Array<{
      readonly settings: ClientSettings;
      readonly resolve: () => void;
    }> = [];
    localApiMocks.setClientSettings.mockImplementation(
      (settings) =>
        new Promise<void>((resolve) => {
          writes.push({ settings, resolve });
        }),
    );
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    updateClientSettings((settings) => ({
      legacySidebarEnabled: !settings.legacySidebarEnabled,
    }));
    expect(getClientSettings().legacySidebarEnabled).toBe(true);

    updateClientSettings((settings) => ({
      legacySidebarEnabled: !settings.legacySidebarEnabled,
    }));
    expect(getClientSettings().legacySidebarEnabled).toBe(false);

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.settings.legacySidebarEnabled).toBe(true);

    writes[0]?.resolve();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.settings.legacySidebarEnabled).toBe(false);
    writes[1]?.resolve();
  });
});
