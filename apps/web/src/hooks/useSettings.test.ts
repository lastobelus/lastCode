import { resolveSidebarMode, useSidebarModeStore } from "../sidebarMode";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  prepareModelPreferencesPatch,
  updateClientSettings,
  toggleSidebarMode,
} from "./useSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

beforeEach(() => {
  persistenceMocks.getClientSettings.mockReset().mockResolvedValue(null);
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
  useSidebarModeStore.setState({ lastcodeHidden: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client settings hydration", () => {
  it.each([false, true])(
    "toggles LastCode presentation without writing either preference, legacy=%s",
    (legacySidebarEnabled) => {
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        lastcodeSidebarEnabled: true,
        legacySidebarEnabled,
      });
      toggleSidebarMode();
      expect(
        resolveSidebarMode(
          getClientSettings(),
          true,
          useSidebarModeStore.getState().lastcodeHidden,
        ),
      ).toBe("inbox");
      toggleSidebarMode();
      expect(
        resolveSidebarMode(
          getClientSettings(),
          true,
          useSidebarModeStore.getState().lastcodeHidden,
        ),
      ).toBe("lastcode");
      expect(getClientSettings()).toMatchObject({
        lastcodeSidebarEnabled: true,
        legacySidebarEnabled,
      });
      expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
    },
  );
  it("ignores mode toggles before hydration and retains normal upstream preference toggling when disabled", async () => {
    toggleSidebarMode();
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
    expect(useSidebarModeStore.getState().lastcodeHidden).toBe(false);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      lastcodeSidebarEnabled: false,
      legacySidebarEnabled: true,
    });
    toggleSidebarMode();
    await updateClientSettings({});
    expect(getClientSettings()).toMatchObject({
      lastcodeSidebarEnabled: false,
      legacySidebarEnabled: false,
    });
    expect(persistenceMocks.setClientSettings).toHaveBeenCalled();
  });
  it("explicitly enabling LastCode reveals it again without changing the upstream preference", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      lastcodeSidebarEnabled: true,
      legacySidebarEnabled: true,
    });
    toggleSidebarMode();
    await updateClientSettings({ lastcodeSidebarEnabled: false });
    expect(
      resolveSidebarMode(getClientSettings(), true, useSidebarModeStore.getState().lastcodeHidden),
    ).toBe("legacy");
    await updateClientSettings({ lastcodeSidebarEnabled: true });
    expect(useSidebarModeStore.getState().lastcodeHidden).toBe(false);
    expect(getClientSettings().legacySidebarEnabled).toBe(true);
  });
  const savedSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    timestampFormat: "12-hour" as const,
    favorites: [{ provider: ProviderInstanceId.make("codex_work"), model: "gpt-5.6" }],
  };
  const onboardingCompletedAt = "2026-09-05T12:00:00.000Z";
  const complete = (current: ClientSettings) => ({ ...current, onboardingCompletedAt });

  it("waits for saved model preferences before applying the first server edit", async () => {
    const provider = ProviderInstanceId.make("codex_work");
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const patch = prepareModelPreferencesPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "new", favorite: true }],
      setModelsHidden: [{ provider, model: "new", hidden: true }],
    });
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    finishRead({
      ...savedSettings,
      providerModelPreferences: {
        [provider]: { hiddenModels: ["saved-hidden"], modelOrder: ["saved-order"] },
      },
    });
    const edited = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, await patch);
    expect(edited.favorites).toEqual([...savedSettings.favorites, { provider, model: "new" }]);
    expect(edited.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["saved-hidden", "new"],
      modelOrder: ["saved-order"],
    });
  });

  // regression: #16816 a failed read could overwrite synced model favorites with defaults
  it("does not prepare a model preference write after a failed legacy read", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings.mockRejectedValueOnce(failure);
    await expect(
      prepareModelPreferencesPatch(DEFAULT_SERVER_SETTINGS, {
        setProviderModelOrder: { provider: ProviderInstanceId.make("codex_work"), modelOrder: [] },
      }),
    ).rejects.toBe(failure);
  });

  it("saves message appearance through hydration and reload without losing sibling preferences", async () => {
    const savedAppearance = {
      ...savedSettings,
      incomingMessageStyle: "outline" as const,
      incomingMessageFillColor: "#223344",
    };
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );

    const hydration = ensureClientSettingsHydrated();
    const styleChange = updateClientSettings({ incomingMessageStyle: "neutral" });
    finishRead(savedAppearance);
    await Promise.all([hydration, styleChange]);
    await updateClientSettings({ incomingMessageFillColor: "#445566" });

    const expected = {
      ...savedAppearance,
      incomingMessageStyle: "neutral" as const,
      incomingMessageFillColor: "#445566",
    };
    expect(persistenceMocks.setClientSettings).toHaveBeenLastCalledWith(expected);

    __resetClientSettingsPersistenceForTests();
    persistenceMocks.getClientSettings.mockResolvedValue(expected);
    await ensureClientSettingsHydrated();
    expect(getClientSettings()).toEqual(expected);

    await updateClientSettings({ incomingMessageFillColor: null });
    expect(persistenceMocks.setClientSettings).toHaveBeenLastCalledWith({
      ...expected,
      incomingMessageFillColor: null,
    });
  });

  it("rejects completion after a failed read and preserves saved preferences on retry", async () => {
    const failure = new Error("storage unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.getClientSettings
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(savedSettings);

    await expect(persistClientSettingsUpdate(complete)).rejects.toBe(failure);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);

    const completedSettings = { ...savedSettings, onboardingCompletedAt };
    await expect(persistClientSettingsUpdate(complete)).resolves.toEqual(completedSettings);
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledExactlyOnceWith(completedSettings);
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledTimes(2);
  });

  it("holds patches until a pending read supplies the saved preferences", async () => {
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const persisted = new Promise<ClientSettings>((resolve) => {
      persistenceMocks.setClientSettings.mockImplementationOnce(async (settings) => {
        resolve(settings);
      });
    });

    const hydration = ensureClientSettingsHydrated();
    persistClientSettingsPatch({ wordWrap: false });
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();

    finishRead(savedSettings);
    await hydration;
    await expect(persisted).resolves.toEqual({ ...savedSettings, wordWrap: false });
    expect(persistenceMocks.getClientSettings).toHaveBeenCalledOnce();
  });

  it("preserves patch order across hydration and a blocked completion write", async () => {
    let finishRead!: (settings: ClientSettings) => void;
    const read = new Promise<ClientSettings>((resolve) => {
      finishRead = resolve;
    });
    persistenceMocks.getClientSettings.mockReturnValue(read);
    let finishCompletionWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      finishCompletionWrite = resolve;
    });
    let signalCompletionWrite!: () => void;
    const completionWriteStarted = new Promise<void>((resolve) => {
      signalCompletionWrite = resolve;
    });
    let durableSettings: ClientSettings = savedSettings;
    const persist = vi
      .fn<(settings: ClientSettings) => Promise<void>>()
      .mockImplementationOnce(async (settings) => {
        signalCompletionWrite();
        await blockedWrite;
        durableSettings = settings;
      })
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });

    const completion = persistClientSettingsUpdate(complete, persist);
    persistClientSettingsPatch({ wordWrap: false }, persist);
    finishRead(savedSettings);
    await completionWriteStarted;
    persistClientSettingsPatch({ wordWrap: true }, persist);
    const finalWrite = persistClientSettingsUpdate((current) => current, persist);

    finishCompletionWrite();
    await completion;
    await finalWrite;

    const expected = { ...savedSettings, onboardingCompletedAt, wordWrap: true };
    expect(getClientSettings()).toEqual(expected);
    expect(durableSettings).toEqual(expected);
  });
});

describe("persistClientSettingsPatch", () => {
  it("waits for settings writes in request order", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    persistenceMocks.setClientSettings.mockImplementationOnce(() => {
      markFirstStarted();
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });

    const firstSettings = { ...DEFAULT_CLIENT_SETTINGS, snapShotFlash: false };
    const secondSettings = { ...firstSettings, snapShotPlaySound: false };
    const first = persistClientSettingsPatch({ snapShotFlash: false });
    await firstStarted;
    const second = persistClientSettingsPatch({ snapShotPlaySound: false });

    expect(persistenceMocks.setClientSettings).toHaveBeenCalledTimes(1);
    expect(getClientSettings()).toEqual(secondSettings);
    finishFirst();
    await Promise.all([first, second]);

    expect(persistenceMocks.setClientSettings).toHaveBeenNthCalledWith(1, firstSettings);
    expect(persistenceMocks.setClientSettings).toHaveBeenNthCalledWith(2, secondSettings);
  });
});

describe("persistClientSettingsUpdate", () => {
  it("publishes the update only after persistence succeeds", async () => {
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const setClientSettings = vi.fn(() => persistence);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        timestampFormat: "12-hour",
      }),
      setClientSettings,
    );

    expect(getClientSettings().timestampFormat).toBe(DEFAULT_CLIENT_SETTINGS.timestampFormat);
    finishPersistence();
    await expect(pending).resolves.toMatchObject({ timestampFormat: "12-hour" });
    expect(getClientSettings().timestampFormat).toBe("12-hour");
  });

  it("preserves an optimistic write made while an awaited update persists", async () => {
    let finishFirstPersistence!: () => void;
    let durableSettings = DEFAULT_CLIENT_SETTINGS;
    const firstPersistence = new Promise<void>((resolve) => {
      finishFirstPersistence = resolve;
    });
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockImplementationOnce((settings) =>
        firstPersistence.then(() => {
          durableSettings = settings;
        }),
      )
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const importedProfile = { id: "profile-import", name: "Imported", kind: "persistent" as const };

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        browserProfiles: [...current.browserProfiles, importedProfile],
      }),
      persist,
    );
    await Promise.resolve();
    const patch = persistClientSettingsPatch({ wordWrap: false }, persist);
    finishFirstPersistence();
    await Promise.all([pending, patch]);

    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      wordWrap: false,
    });
    expect(persist.mock.calls[1]?.[0].browserProfiles).toContainEqual(importedProfile);
    expect(durableSettings.wordWrap).toBe(false);
    expect(durableSettings.browserProfiles).toContainEqual(importedProfile);
    expect(getClientSettings().wordWrap).toBe(false);
    expect(getClientSettings().browserProfiles).toContainEqual(importedProfile);
  });
});

describe("mergeEnvironmentSettings", () => {
  it("keeps server settlement settings when legacy client data contains retired keys", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarAutoSettleAfterDays: 14,
      sidebarAutoSettleOnMerge: false,
    };
    const legacyClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAutoSettleAfterDays: 1,
      sidebarAutoSettleOnMerge: true,
    };

    const settings = mergeEnvironmentSettings(serverSettings, legacyClientSettings);

    expect(settings.sidebarAutoSettleAfterDays).toBe(14);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
  });
});

describe("onboarding completion persistence", () => {
  it("keeps onboarding incomplete after a failed save and preserves preferences on retry", async () => {
    const failure = new Error("disk full");
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const existingSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_work"),
          model: "gpt-5.6",
        },
      ],
    };
    __setClientSettingsForTests(existingSettings);
    const onboardingCompletedAt = "2026-09-01T12:00:00.000Z";
    const complete = (current: typeof DEFAULT_CLIENT_SETTINGS) => ({
      ...current,
      onboardingCompletedAt,
    });

    await expect(persistClientSettingsUpdate(complete, persist)).rejects.toBe(failure);
    expect(getClientSettings()).toBe(existingSettings);
    expect(getClientSettings().onboardingCompletedAt).toBeNull();

    const completedSettings = { ...existingSettings, onboardingCompletedAt };
    await expect(persistClientSettingsUpdate(complete, persist)).resolves.toEqual(
      completedSettings,
    );
    expect(getClientSettings()).toEqual(completedSettings);
    expect(persist).toHaveBeenLastCalledWith(completedSettings);
  });
});

it("uses the environment's model preferences after migration, including empty lists", () => {
  const client = {
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: ProviderInstanceId.make("codex_work"), model: "old" }],
    providerModelPreferences: { codex_work: { hiddenModels: ["old"], modelOrder: [] } },
  };
  expect(mergeEnvironmentSettings(DEFAULT_SERVER_SETTINGS, client).favorites).toEqual(
    client.favorites,
  );
  const merged = mergeEnvironmentSettings(
    { ...DEFAULT_SERVER_SETTINGS, favorites: [], providerModelPreferences: {} },
    client,
  );
  expect(merged.favorites).toEqual([]);
  expect(merged.providerModelPreferences).toEqual({});
});

describe("LastCode sidebar persistence", () => {
  it.each([false, true])(
    "preserves upstream legacy=%s through override, reload and restore",
    async (legacySidebarEnabled) => {
      let saved = { ...DEFAULT_CLIENT_SETTINGS, legacySidebarEnabled, legacySidebarScale: 75 };
      persistenceMocks.getClientSettings.mockImplementation(async () => saved);
      persistenceMocks.setClientSettings.mockImplementation(async (settings) => {
        saved = settings;
      });
      await ensureClientSettingsHydrated();
      expect(getClientSettings().lastcodeSidebarEnabled).toBe(false);
      await updateClientSettings({ lastcodeSidebarEnabled: true });
      expect(saved.legacySidebarEnabled).toBe(legacySidebarEnabled);
      __resetClientSettingsPersistenceForTests();
      await ensureClientSettingsHydrated();
      expect(resolveSidebarMode(getClientSettings())).toBe("lastcode");
      expect(getClientSettings().legacySidebarScale).toBe(75);
      await updateClientSettings({ lastcodeSidebarEnabled: false });
      expect(saved.legacySidebarEnabled).toBe(legacySidebarEnabled);
      expect(resolveSidebarMode(saved)).toBe(legacySidebarEnabled ? "legacy" : "inbox");
    },
  );
});

it("persists a family subheader opt-out independently of grouping and compact status", async () => {
  let saved: ClientSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    legacySidebarThreadGroupingStyle: "typed-groups",
  };
  persistenceMocks.getClientSettings.mockImplementation(async () => saved);
  persistenceMocks.setClientSettings.mockImplementation(async (settings) => {
    saved = settings;
  });
  await ensureClientSettingsHydrated();
  expect(getClientSettings().lastcodeSidebarFamilyStatusSubheaders).toBe(true);
  await updateClientSettings({ lastcodeSidebarFamilyStatusSubheaders: false });
  __resetClientSettingsPersistenceForTests();
  await ensureClientSettingsHydrated();
  expect(getClientSettings().lastcodeSidebarFamilyStatusSubheaders).toBe(false);
  expect(
    mergeEnvironmentSettings(DEFAULT_SERVER_SETTINGS, getClientSettings())
      .lastcodeSidebarFamilyStatusSubheaders,
  ).toBe(false);
  expect(saved.legacySidebarThreadGroupingStyle).toBe("typed-groups");
  expect(saved.compactLegacySidebarStatuses).toBe(false);
});

describe("updateClientSettings", () => {
  it("applies repeated functional updates and persists them in invocation order", async () => {
    const writes: Array<{
      readonly settings: ClientSettings;
      readonly resolve: () => void;
    }> = [];
    persistenceMocks.setClientSettings.mockImplementation(
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
    expect(writes[0]?.settings.legacySidebarEnabled).toBe(false);
    writes[0]?.resolve();
  });
});
