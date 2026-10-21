import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  requiredScopesForProjectMutation,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  StorageCleanupReport,
  DEFAULT_HANDOFFS_MENU_LIMIT,
  MAX_HANDOFFS_MENU_LIMIT,
  MIN_HANDOFFS_MENU_LIMIT,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

const encodeCleanupReport = Schema.encodeSync(StorageCleanupReport);
const decodeCleanupReport = Schema.decodeUnknownSync(StorageCleanupReport);
const previousReport = Schema.Struct({
  trigger: Schema.Literals(["automatic", "manual"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
      outcome: Schema.Literals(["removed", "kept", "failed"]),
      reason: Schema.String,
      path: Schema.NullOr(Schema.String),
      threadId: Schema.NullOr(Schema.String),
      threadTitle: Schema.NullOr(Schema.String),
      bytes: Schema.NullOr(Schema.Number),
      files: Schema.NullOr(Schema.Number),
    }),
  ),
  counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
  omittedCount: Schema.Number,
  bytesFreed: Schema.Number,
});
const decodePreviousCleanupReport = Schema.decodeUnknownSync(previousReport);

describe("storage cleanup report wire format", () => {
  it("keeps dependency outcomes decodable by clients predating dependency reports", () => {
    // This is the report decoder shipped before dependency reporting. Unknown
    // additive fields can be ignored, but a new kind would reject the whole report.
    const report = {
      trigger: "manual" as const,
      startedAt: "2026-06-10T12:00:00.000Z",
      finishedAt: "2026-06-10T12:00:01.000Z",
      entries: [
        {
          kind: "worktree" as const,
          worktreeResource: "dependencies" as const,
          outcome: "removed" as const,
          reason: "Dependency install removed",
          path: "/managed-worktrees/example/node_modules",
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes: 1024,
          files: null,
        },
      ],
      counts: { removed: 1, kept: 0, failed: 0 },
      omittedCount: 0,
      bytesFreed: 1024,
    };
    const wire = encodeCleanupReport(report);
    expect(decodePreviousCleanupReport(wire).entries).toEqual([
      expect.objectContaining({
        kind: "worktree",
        outcome: "removed",
        reason: "Dependency install removed",
        path: report.entries[0]!.path,
      }),
    ]);
    expect(decodeCleanupReport(wire).entries[0]?.worktreeResource).toBe("dependencies");
  });
});

describe("ServerSettings local CI limits", () => {
  it("uses responsive defaults and fills omitted persisted limits", () => {
    expect(decodeServerSettings({}).lastcodeLocalCi).toEqual({
      quickCiMode: "auto",
      maxConcurrentRuns: 1,
      packageConcurrency: 1,
      compilerThreads: 2,
      backgroundPriority: true,
    });
    expect(
      decodeServerSettings({ lastcodeLocalCi: { packageConcurrency: 3 } }).lastcodeLocalCi,
    ).toEqual({ ...DEFAULT_SERVER_SETTINGS.lastcodeLocalCi, packageConcurrency: 3 });
  });

  it("preserves partial patches and round-trips the maximum limits", () => {
    expect(decodeServerSettingsPatch({ lastcodeLocalCi: { compilerThreads: 4 } })).toEqual({
      lastcodeLocalCi: { compilerThreads: 4 },
    });
    const input = {
      lastcodeLocalCi: {
        maxConcurrentRuns: 4,
        packageConcurrency: 8,
        compilerThreads: 16,
        backgroundPriority: false,
      },
    };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });

  it.each(["auto", "local", "github"])(
    "round-trips Quick CI mode %s without filling partial writes",
    (quickCiMode) => {
      const input = { lastcodeLocalCi: { quickCiMode } };
      expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
      expect(decodeServerSettingsPatch(input)).toEqual(input);
    },
  );

  it.each([
    ["maxConcurrentRuns", 0],
    ["maxConcurrentRuns", 5],
    ["packageConcurrency", 0],
    ["packageConcurrency", 9],
    ["compilerThreads", 0],
    ["compilerThreads", 17],
    ["compilerThreads", 1.5],
    ["backgroundPriority", "true"],
    ["quickCiMode", "unsupported"],
  ])("rejects invalid %s: %s", (key, value) => {
    const input = { lastcodeLocalCi: { [key]: value } };
    expect(() => decodeServerSettings(input)).toThrow();
    expect(() => decodeServerSettingsPatch(input)).toThrow();
  });
});

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeDependenciesAfterDays: null,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts dependency retention and keeps it off in saved older custom rules", () => {
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeDependenciesAfterDays: 14 } }),
    ).toEqual({ storageCleanup: { worktreeDependenciesAfterDays: 14 } });
    expect(
      decodeServerSettings({
        worktreeCleanup: {
          mode: "custom",
          rules: {
            worktreeAfterDays: null,
            worktreeOnMerge: false,
            worktreeOnDelete: false,
            worktreeUnchanged: false,
          },
        },
      }).worktreeCleanup,
    ).toMatchObject({ mode: "custom", rules: { worktreeDependenciesAfterDays: null } });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ClientSettings LastCode status icons", () => {
  it("defaults to no overrides and leaves omitted patches unchanged", () => {
    expect(decodeClientSettings({}).lastcodeStatusIcons).toEqual({});
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("lastcodeStatusIcons");
  });

  it("persists and patches arbitrary status keys with every supported shape and style", () => {
    const lastcodeStatusIcons = {
      working: { shape: "triangle", style: "open" },
      stopped: { shape: "square", style: "solid" },
      "future-status": { shape: "diamond", style: "open" },
      custom: { shape: "circle", style: "solid" },
      tinted: { shape: "triangle-right", style: "outline-fill" },
    };
    const preference = { lastcodeStatusIcons };
    expect(encodeClientSettings(decodeClientSettings(preference))).toMatchObject(preference);
    expect(decodeClientSettingsPatch(preference)).toEqual(preference);
    expect(decodeClientSettingsPatch({ lastcodeStatusIcons: {} })).toEqual({
      lastcodeStatusIcons: {},
    });
  });

  it.each([
    null,
    "triangle",
    { working: { shape: "star", style: "open" } },
    { working: { shape: "triangle", style: "filled" } },
    { working: { shape: "circle" } },
    { working: { style: "solid" } },
    { working: null },
  ])("rejects invalid overrides: %j", (lastcodeStatusIcons) => {
    expect(() => decodeClientSettings({ lastcodeStatusIcons })).toThrow();
    expect(() => decodeClientSettingsPatch({ lastcodeStatusIcons })).toThrow();
  });
});

describe("handoffs menu setting", () => {
  it("defaults to seven and accepts the inclusive bounds", () => {
    expect(decodeClientSettings({}).handoffsMenuLimit).toBe(DEFAULT_HANDOFFS_MENU_LIMIT);
    expect(
      decodeClientSettings({ handoffsMenuLimit: MIN_HANDOFFS_MENU_LIMIT }).handoffsMenuLimit,
    ).toBe(1);
    expect(
      decodeClientSettings({ handoffsMenuLimit: MAX_HANDOFFS_MENU_LIMIT }).handoffsMenuLimit,
    ).toBe(50);
    expect(decodeClientSettingsPatch({ handoffsMenuLimit: 12 }).handoffsMenuLimit).toBe(12);
  });

  it("rejects non-integers and values outside the bounds", () => {
    for (const value of [0, 51, 1.5, "7"]) {
      expect(() => decodeClientSettings({ handoffsMenuLimit: value })).toThrow();
      expect(() => decodeClientSettingsPatch({ handoffsMenuLimit: value })).toThrow();
    }
  });
});
describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("ClientSettings environment icons", () => {
  it("defaults to semantic colors with the local icon hidden", () => {
    const settings = decodeClientSettings({});
    expect(settings.environmentIconColors).toEqual({});
    expect(settings.showLocalEnvironmentIcon).toBe(false);
  });

  it("accepts per-environment hex colors and the local icon opt-in", () => {
    const input = {
      environmentIconColors: { primary: "#2563eb", remote: "#7C3AED" },
      showLocalEnvironmentIcon: true,
    };
    expect(decodeClientSettings(input)).toMatchObject(input);
    expect(decodeClientSettingsPatch(input)).toEqual(input);
  });

  it.each(["blue", "#123", "#12345678", "#gg0000"])(
    "rejects an invalid environment icon color: %s",
    (color) => {
      expect(() => decodeClientSettings({ environmentIconColors: { primary: color } })).toThrow();
      expect(() =>
        decodeClientSettingsPatch({ environmentIconColors: { primary: color } }),
      ).toThrow();
    },
  );
});

describe("ClientSettings thread provider badges", () => {
  it("enables opaque provider badges at 80% for existing client settings", () => {
    const settings = decodeClientSettings({ showLocalEnvironmentIcon: false });
    expect(settings.showThreadProviderBadge).toBe(true);
    expect(settings.threadProviderBadgeSize).toBe(80);
    expect(settings.threadProviderBadgeTransparency).toBe(0);
  });

  it("keeps omitted badge preferences out of partial updates", () => {
    const patch = decodeClientSettingsPatch({ showLocalEnvironmentIcon: true });
    expect(patch).not.toHaveProperty("showThreadProviderBadge");
    expect(patch).not.toHaveProperty("threadProviderBadgeSize");
    expect(patch).not.toHaveProperty("threadProviderBadgeTransparency");
  });

  it("persists badge appearance while badges are disabled", () => {
    const input = {
      showThreadProviderBadge: false,
      threadProviderBadgeSize: 65,
      threadProviderBadgeTransparency: 30,
    };
    expect(decodeClientSettings(input)).toMatchObject(input);
    expect(decodeClientSettingsPatch(input)).toEqual(input);
  });

  it.each([
    ["threadProviderBadgeSize", 10, 100],
    ["threadProviderBadgeTransparency", 0, 100],
  ] as const)("validates percentage bounds for %s", (key, minimum, maximum) => {
    for (const value of [minimum, maximum]) {
      expect(decodeClientSettings({ [key]: value })[key]).toBe(value);
      expect(decodeClientSettingsPatch({ [key]: value })).toEqual({ [key]: value });
    }
    for (const value of [minimum - 1, maximum + 1, minimum + 0.5, "50", null]) {
      expect(() => decodeClientSettings({ [key]: value })).toThrow();
      expect(() => decodeClientSettingsPatch({ [key]: value })).toThrow();
    }
  });

  it.each(["yes", 1, null])("rejects a non-boolean badge toggle: %s", (value) => {
    expect(() => decodeClientSettings({ showThreadProviderBadge: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ showThreadProviderBadge: value })).toThrow();
  });
});

describe("ClientSettings project icons", () => {
  it("defaults to unrounded icons and preserves an explicit opt-in", () => {
    expect(decodeClientSettings({}).roundedProjectIcons).toBe(false);
    expect(decodeClientSettings({ roundedProjectIcons: true }).roundedProjectIcons).toBe(true);
    expect(decodeClientSettingsPatch({ roundedProjectIcons: true }).roundedProjectIcons).toBe(true);
  });
});

describe("ClientSettings LastCode sidebar preferences", () => {
  it("defaults to the current sidebar", () => {
    const settings = decodeClientSettings({});
    expect(settings.compactLegacySidebarStatuses).toBe(false);
    expect(settings.showThreadWorktreeIndicators).toBe(true);
    expect(settings.legacySidebarScale).toBe(100);
    expect(settings.legacySidebarThreadGroupingStyle).toBe("minimal");
    expect(settings.legacySidebarEnabled).toBe(false);
    expect(settings.lastcodeSidebarEnabled).toBe(false);
  });

  it("preserves an explicit thread grouping choice", () => {
    expect(
      decodeClientSettings({ legacySidebarThreadGroupingStyle: "typed-groups" })
        .legacySidebarThreadGroupingStyle,
    ).toBe("typed-groups");
    expect(
      decodeClientSettings({ legacySidebarThreadGroupingStyle: "minimal" })
        .legacySidebarThreadGroupingStyle,
    ).toBe("minimal");
  });

  it.each([false, true])(
    "decodes the independent LastCode choice with legacy=%s",
    (legacySidebarEnabled) => {
      const input = { lastcodeSidebarEnabled: true, legacySidebarEnabled, legacySidebarScale: 75 };
      expect(decodeClientSettings(input)).toMatchObject(input);
      expect(decodeClientSettingsPatch(input)).toEqual(input);
      expect(decodeClientSettings({ legacySidebarEnabled }).lastcodeSidebarEnabled).toBe(false);
    },
  );

  it.each(["yes", 1, null])(
    "rejects an invalid LastCode sidebar choice: %s",
    (lastcodeSidebarEnabled) => {
      expect(() => decodeClientSettings({ lastcodeSidebarEnabled })).toThrow();
      expect(() => decodeClientSettingsPatch({ lastcodeSidebarEnabled })).toThrow();
    },
  );

  it("defaults family status subheaders on and preserves an explicit opt-out", () => {
    expect(decodeClientSettings({}).lastcodeSidebarFamilyStatusSubheaders).toBe(true);
    expect(
      decodeClientSettings({ legacySidebarEnabled: true }).lastcodeSidebarFamilyStatusSubheaders,
    ).toBe(true);
    expect(
      decodeClientSettings({ lastcodeSidebarFamilyStatusSubheaders: false })
        .lastcodeSidebarFamilyStatusSubheaders,
    ).toBe(false);
    expect(decodeClientSettingsPatch({ lastcodeSidebarFamilyStatusSubheaders: false })).toEqual({
      lastcodeSidebarFamilyStatusSubheaders: false,
    });
    expect(() =>
      decodeClientSettingsPatch({ lastcodeSidebarFamilyStatusSubheaders: "false" }),
    ).toThrow();
  });

  it("preserves compact legacy sidebar status indicators", () => {
    expect(
      decodeClientSettings({ compactLegacySidebarStatuses: true }).compactLegacySidebarStatuses,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ compactLegacySidebarStatuses: true })
        .compactLegacySidebarStatuses,
    ).toBe(true);
  });

  it("preserves an explicit worktree indicator preference", () => {
    expect(
      decodeClientSettings({ showThreadWorktreeIndicators: false }).showThreadWorktreeIndicators,
    ).toBe(false);
    expect(
      decodeClientSettingsPatch({ showThreadWorktreeIndicators: false })
        .showThreadWorktreeIndicators,
    ).toBe(false);
  });

  it.each([50, 75, 100])("accepts a legacy sidebar scale within 50..100: %s", (value) => {
    expect(decodeClientSettings({ legacySidebarScale: value }).legacySidebarScale).toBe(value);
    expect(decodeClientSettingsPatch({ legacySidebarScale: value }).legacySidebarScale).toBe(value);
  });

  it.each([49, 101, 74.5])("rejects an invalid legacy sidebar scale: %s", (value) => {
    expect(() => decodeClientSettings({ legacySidebarScale: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ legacySidebarScale: value })).toThrow();
  });
});

describe("ClientSettings incoming message appearance", () => {
  it("uses neutral theme fill when existing settings have no appearance choice", () => {
    expect(decodeClientSettings({ timestampFormat: "12-hour" })).toMatchObject({
      incomingMessageStyle: "neutral",
      incomingMessageFillColor: null,
      timestampFormat: "12-hour",
    });
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("incomingMessageStyle");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("incomingMessageFillColor");
  });

  it.each(["neutral", "outline"])("round-trips the %s style with a saved fill", (style) => {
    const preference = { incomingMessageStyle: style, incomingMessageFillColor: "#a1B2c3" };
    expect(encodeClientSettings(decodeClientSettings(preference))).toMatchObject(preference);
    expect(decodeClientSettingsPatch(preference)).toEqual(preference);
  });

  it("accepts an explicit reset to automatic theme fill", () => {
    expect(decodeClientSettingsPatch({ incomingMessageFillColor: null })).toEqual({
      incomingMessageFillColor: null,
    });
    expect(
      encodeClientSettings(decodeClientSettings({ incomingMessageFillColor: null }))
        .incomingMessageFillColor,
    ).toBeNull();
  });

  it("rejects unsupported styles", () => {
    expect(() => decodeClientSettings({ incomingMessageStyle: "filled" })).toThrow();
    expect(() => decodeClientSettingsPatch({ incomingMessageStyle: "filled" })).toThrow();
  });

  it.each(["", "red", "#abc", "#aabbccdd", "#gggggg", "rgb(0,0,0)"])(
    "rejects invalid fill color %s",
    (incomingMessageFillColor) => {
      expect(() => decodeClientSettings({ incomingMessageFillColor })).toThrow();
      expect(() => decodeClientSettingsPatch({ incomingMessageFillColor })).toThrow();
    },
  );
});

describe("ClientSettings larger scrollbars", () => {
  it("is opt-in with defaults that clear the pane resize target", () => {
    const settings = decodeClientSettings({});

    expect(settings.largerScrollbarsEnabled).toBe(false);
    expect(settings.scrollbarWidth).toBe(10);
    expect(settings.scrollbarMargin).toBe(4);
  });

  it.each([
    ["scrollbarWidth", 1, 12],
    ["scrollbarMargin", 0, 6],
  ] as const)("accepts the inclusive %s range", (key, minimum, maximum) => {
    expect(decodeClientSettingsPatch({ [key]: minimum })).toEqual({ [key]: minimum });
    expect(decodeClientSettingsPatch({ [key]: maximum })).toEqual({ [key]: maximum });
    expect(() => decodeClientSettingsPatch({ [key]: minimum - 1 })).toThrow();
    expect(() => decodeClientSettingsPatch({ [key]: maximum + 1 })).toThrow();
  });
});

it.each([-1, 1.5, 3651])("rejects invalid dependency retention %s", (days) => {
  expect(() =>
    decodeServerSettingsPatch({ storageCleanup: { worktreeDependenciesAfterDays: days } }),
  ).toThrow();
});
