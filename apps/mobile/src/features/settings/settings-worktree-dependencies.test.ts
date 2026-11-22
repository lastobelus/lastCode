import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  resolveMobileSettingsTargets,
} from "./settings-scoped-server";
import {
  parseMobileRetentionDays,
  planMobileWorktreeDependencyCleanup,
  resolveMobileWorktreeDependencySettings,
  supportsMobileWorktreeDependencyCleanup,
} from "./settings-worktree-dependencies";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;
const defaultRules = resolveWorktreeCleanup(DEFAULT_SERVER_SETTINGS, null);
const capabilities = {
  repositoryIdentity: true,
  storageCleanup: true,
  worktreeDependencyCleanup: true,
  projectWorktreeCleanup: true,
  projectSettingsOverrides: true,
};

function environment(
  environmentId: EnvironmentId,
  patch: Partial<ServerSettings> = {},
  supported: SettingsTarget["serverConfig"]["environment"]["capabilities"] = capabilities,
): SettingsTarget {
  return {
    environmentId,
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, ...patch },
      environment: { capabilities: supported },
    },
  } as SettingsTarget;
}

describe("mobile worktree dependency retention", () => {
  it("changes only dependency retention in every environment", () => {
    const environments = [
      environment(firstId, {
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeOnMerge: true,
          logsAfterDays: 30,
        },
      }),
      environment(secondId, {
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: 90,
          browserArtifactsAfterDays: 14,
        },
      }),
    ];
    const targets = resolveMobileSettingsTargets(environments, null);
    expect(resolveMobileWorktreeDependencySettings(targets).enabled).toBe(false);
    expect(planMobileWorktreeDependencyCleanup(targets, false, { kind: "days", value: 8 })).toEqual(
      environments.map((entry) => ({
        environmentId: entry.environmentId,
        patch: { storageCleanup: { worktreeDependenciesAfterDays: 8 } },
      })),
    );
    expect(
      planMobileWorktreeDependencyCleanup(targets, false, { kind: "days", value: null }),
    ).toEqual(
      environments.map((entry) => ({
        environmentId: entry.environmentId,
        patch: { storageCleanup: { worktreeDependenciesAfterDays: null } },
      })),
    );
  });

  it("updates the active environment worktree policy without changing its other rules", () => {
    const rules = { ...defaultRules, worktreeAfterDays: 20, worktreeOnMerge: true };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, { worktreeCleanup: { mode: "custom", rules } })],
      null,
    );
    expect(
      planMobileWorktreeDependencyCleanup(targets, false, { kind: "days", value: 12 }),
    ).toEqual([
      {
        environmentId: firstId,
        patch: {
          storageCleanup: { worktreeDependenciesAfterDays: 12 },
          worktreeCleanup: {
            mode: "custom",
            rules: { ...rules, worktreeDependenciesAfterDays: 12 },
          },
        },
      },
    ]);
  });

  it("shows mixed enabled days separately from a mix of enabled and off", () => {
    const makeEnvironment = (environmentId: EnvironmentId, days: number | null) =>
      environment(environmentId, {
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeDependenciesAfterDays: days,
        },
      });
    expect(
      resolveMobileWorktreeDependencySettings(
        resolveMobileSettingsTargets(
          [makeEnvironment(firstId, 8), makeEnvironment(secondId, 14)],
          null,
        ),
      ),
    ).toMatchObject({ days: null, mixedDays: true, enabled: true });
    expect(
      resolveMobileWorktreeDependencySettings(
        resolveMobileSettingsTargets(
          [makeEnvironment(firstId, 8), makeEnvironment(secondId, null)],
          null,
        ),
      ),
    ).toMatchObject({ days: null, mixedDays: true, enabled: null });
  });

  it.each(["storageCleanup", "worktreeDependencyCleanup"] as const)(
    "rejects the whole environment selection when one server lacks %s",
    (capability) => {
      const environments = [
        environment(firstId),
        environment(secondId, {}, { ...capabilities, [capability]: false }),
      ];
      const targets = resolveMobileSettingsTargets(environments, null);
      expect(supportsMobileWorktreeDependencyCleanup(targets, false)).toBe(false);
      expect(
        planMobileWorktreeDependencyCleanup(targets, false, { kind: "days", value: 8 }),
      ).toEqual([]);
    },
  );

  it.each(["projectWorktreeCleanup", "projectSettingsOverrides"] as const)(
    "rejects every project write when one server lacks %s",
    (capability) => {
      const environments = [
        environment(firstId),
        environment(secondId, {}, { ...capabilities, [capability]: false }),
      ];
      const targets = resolveMobileSettingsTargets(environments, [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ]);
      expect(supportsMobileWorktreeDependencyCleanup(targets, true)).toBe(false);
      for (const value of ["inherit", "off", "custom"] as const) {
        expect(planMobileWorktreeDependencyCleanup(targets, true, { kind: "mode", value })).toEqual(
          [],
        );
      }
    },
  );

  it("requires advertised capabilities and a connected target", () => {
    expect(supportsMobileWorktreeDependencyCleanup([], false)).toBe(false);
    expect(
      supportsMobileWorktreeDependencyCleanup(
        resolveMobileSettingsTargets(
          [environment(firstId, {}, { repositoryIdentity: false })],
          null,
        ),
        false,
      ),
    ).toBe(false);
    expect(planMobileWorktreeDependencyCleanup([], false, { kind: "days", value: 8 })).toEqual([]);
  });

  it.each([0, -1, 3651, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not send invalid day value %s",
    (value) => {
      const targets = resolveMobileSettingsTargets([environment(firstId)], null);
      expect(planMobileWorktreeDependencyCleanup(targets, false, { kind: "days", value })).toEqual(
        [],
      );
    },
  );

  it.each([1, 3650])("accepts boundary day value %s", (value) => {
    const targets = resolveMobileSettingsTargets([environment(firstId)], null);
    expect(planMobileWorktreeDependencyCleanup(targets, false, { kind: "days", value })).toEqual([
      {
        environmentId: firstId,
        patch: { storageCleanup: { worktreeDependenciesAfterDays: value } },
      },
    ]);
  });
});

describe("mobile project cleanup policies", () => {
  it("allows supported project members while excluding an unrelated unsupported environment", () => {
    const rules = { ...defaultRules, worktreeDependenciesAfterDays: 21, worktreeOnMerge: true };
    const environments = [
      environment(firstId, {
        projectSettingsOverrides: {
          [firstProject]: {
            defaultAutoPull: true,
            continueThreadsAfterServerUpdate: true,
            worktreeCleanup: { mode: "custom", rules },
          },
        },
      }),
      environment(secondId, {}, { repositoryIdentity: true }),
    ];
    const targets = resolveMobileSettingsTargets(environments, [
      { environmentId: firstId, id: firstProject },
    ]);

    expect(supportsMobileWorktreeDependencyCleanup(targets, true)).toBe(true);
    expect(
      supportsMobileWorktreeDependencyCleanup(
        resolveMobileSettingsTargets(environments, null),
        false,
      ),
    ).toBe(false);
    expect(resolveMobileWorktreeDependencySettings(targets)).toMatchObject({
      mode: "custom",
      days: 21,
      enabled: true,
    });
    expect(planMobileWorktreeDependencyCleanup(targets, true, { kind: "days", value: 14 })).toEqual(
      [
        {
          environmentId: firstId,
          patch: {
            projectSettingsOverrides: {
              [firstProject]: {
                defaultAutoPull: true,
                continueThreadsAfterServerUpdate: true,
                worktreeCleanup: {
                  mode: "custom",
                  rules: { ...rules, worktreeDependenciesAfterDays: 14 },
                },
              },
            },
          },
        },
      ],
    );
    expect(
      planMobileScopedSettingsClear(targets, [
        "worktreeCleanup",
        "continueThreadsAfterServerUpdate",
      ]),
    ).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);

    const noProjectTargets = resolveMobileSettingsTargets(environments, []);
    expect(supportsMobileWorktreeDependencyCleanup(noProjectTargets, true)).toBe(false);
    expect(
      planMobileWorktreeDependencyCleanup(noProjectTargets, true, {
        kind: "mode",
        value: "custom",
      }),
    ).toEqual([]);
  });

  it("preserves separate rules and unrelated overrides for multiple checkouts on one server", () => {
    const firstRules = { ...defaultRules, worktreeAfterDays: 21, worktreeOnMerge: true };
    const secondRules = { ...defaultRules, worktreeAfterDays: 60, worktreeOnDelete: true };
    const environments = [
      environment(firstId, {
        projectSettingsOverrides: {
          [firstProject]: {
            defaultAutoPull: true,
            worktreeCleanup: { mode: "custom", rules: firstRules },
          },
          [secondProject]: {
            responseStreamingMode: "paragraph",
            worktreeCleanup: { mode: "custom", rules: secondRules },
          },
        },
      }),
    ];
    const targets = resolveMobileSettingsTargets(environments, [
      { environmentId: firstId, id: firstProject },
      { environmentId: firstId, id: secondProject },
    ]);
    for (const value of [8, null]) {
      expect(planMobileWorktreeDependencyCleanup(targets, true, { kind: "days", value })).toEqual([
        {
          environmentId: firstId,
          patch: {
            projectSettingsOverrides: {
              [firstProject]: {
                defaultAutoPull: true,
                worktreeCleanup: {
                  mode: "custom",
                  rules: { ...firstRules, worktreeDependenciesAfterDays: value },
                },
              },
              [secondProject]: {
                responseStreamingMode: "paragraph",
                worktreeCleanup: {
                  mode: "custom",
                  rules: { ...secondRules, worktreeDependenciesAfterDays: value },
                },
              },
            },
          },
        },
      ]);
    }
  });

  it("seeds Custom from each checkout's current rules and retains an existing custom policy", () => {
    const inheritedRules = { ...defaultRules, worktreeAfterDays: 45, worktreeOnDelete: true };
    const customRules = {
      ...defaultRules,
      worktreeDependenciesAfterDays: 14,
      worktreeOnMerge: true,
    };
    const targets = resolveMobileSettingsTargets(
      [
        environment(firstId, {
          storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, ...inheritedRules },
          projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } },
        }),
        environment(secondId, {
          projectSettingsOverrides: {
            [secondProject]: { worktreeCleanup: { mode: "custom", rules: customRules } },
          },
        }),
      ],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );
    expect(resolveMobileWorktreeDependencySettings(targets).mode).toBeNull();
    expect(
      planMobileWorktreeDependencyCleanup(targets, true, { kind: "mode", value: "custom" }),
    ).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultAutoPull: true,
              worktreeCleanup: { mode: "custom", rules: inheritedRules },
            },
          },
        },
      },
      {
        environmentId: secondId,
        patch: {
          projectSettingsOverrides: {
            [secondProject]: { worktreeCleanup: { mode: "custom", rules: customRules } },
          },
        },
      },
    ]);
    expect(planMobileWorktreeDependencyCleanup(targets, true, { kind: "days", value: 8 })).toEqual(
      [],
    );
  });

  it("keeps automatic cleanup off when switching an Off policy to Custom", () => {
    const targets = resolveMobileSettingsTargets(
      [
        environment(firstId, {
          storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeOnDelete: true },
          projectSettingsOverrides: { [firstProject]: { worktreeCleanup: { mode: "off" } } },
        }),
      ],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(resolveMobileWorktreeDependencySettings(targets)).toMatchObject({
      mode: "off",
      days: null,
      enabled: false,
    });
    expect(
      planMobileWorktreeDependencyCleanup(targets, true, { kind: "mode", value: "custom" }),
    ).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { worktreeCleanup: { mode: "custom", rules: defaultRules } },
          },
        },
      },
    ]);
  });

  it("sets Off explicitly and Inherit clears only cleanup, while page reset clears both Maintenance overrides", () => {
    const targets = resolveMobileSettingsTargets(
      [
        environment(firstId, {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultAutoPull: true,
              continueThreadsAfterServerUpdate: true,
              worktreeCleanup: { mode: "custom", rules: defaultRules },
            },
          },
        }),
      ],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(
      planMobileWorktreeDependencyCleanup(targets, true, { kind: "mode", value: "off" }),
    ).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultAutoPull: true,
              continueThreadsAfterServerUpdate: true,
              worktreeCleanup: { mode: "off" },
            },
          },
        },
      },
    ]);
    expect(
      planMobileWorktreeDependencyCleanup(targets, true, { kind: "mode", value: "inherit" }),
    ).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { defaultAutoPull: true, continueThreadsAfterServerUpdate: true },
          },
        },
      },
    ]);
    expect(
      planMobileScopedSettingsClear(targets, [
        "worktreeCleanup",
        "continueThreadsAfterServerUpdate",
      ]),
    ).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
  });

  it("reports Inherit independently of an environment's own custom policy", () => {
    const rules = { ...defaultRules, worktreeDependenciesAfterDays: 10 };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, { worktreeCleanup: { mode: "custom", rules } })],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(resolveMobileWorktreeDependencySettings(targets)).toMatchObject({
      mode: "inherit",
      days: 10,
      enabled: true,
    });
    expect(planMobileWorktreeDependencyCleanup(targets, true, { kind: "days", value: 8 })).toEqual(
      [],
    );
  });
});

describe("mobile retention day editing", () => {
  it.each(["", " ", "0", "-1", "3651", "1.5", "1day", "1e2", "Infinity"])(
    "rejects the whole invalid draft %s",
    (text) => expect(parseMobileRetentionDays(text)).toBeNull(),
  );
  it.each([
    ["1", 1],
    ["3650", 3650],
    [" 14 ", 14],
  ] as const)("accepts integer draft %s", (text, days) =>
    expect(parseMobileRetentionDays(text)).toBe(days),
  );
});
