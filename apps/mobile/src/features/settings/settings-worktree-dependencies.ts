import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type { SettingsTarget } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export const MIN_MOBILE_RETENTION_DAYS = 1;
export const MAX_MOBILE_RETENTION_DAYS = 3650;
export const DEFAULT_MOBILE_DEPENDENCY_RETENTION_DAYS = 8;

export function parseMobileRetentionDays(text: string): number | null {
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isInteger(value) &&
    value >= MIN_MOBILE_RETENTION_DAYS &&
    value <= MAX_MOBILE_RETENTION_DAYS
    ? value
    : null;
}

export function supportsMobileWorktreeDependencyCleanup(
  environments: readonly SettingsTarget[],
  projectSelected: boolean,
) {
  return (
    environments.length > 0 &&
    environments.every(({ serverConfig }) => {
      const capabilities = serverConfig.environment.capabilities;
      return (
        capabilities.storageCleanup === true &&
        capabilities.worktreeDependencyCleanup === true &&
        (!projectSelected ||
          (capabilities.projectWorktreeCleanup === true &&
            capabilities.projectSettingsOverrides === true))
      );
    })
  );
}

export type MobileWorktreeCleanupMode = "inherit" | "off" | "custom";

function projectCleanupMode(target: ScopedMobileSettingsTarget): MobileWorktreeCleanupMode {
  return target.sources.worktreeCleanup === "project"
    ? (target.settings.worktreeCleanup?.mode ?? "inherit")
    : "inherit";
}

export function resolveMobileWorktreeDependencySettings(
  targets: readonly ScopedMobileSettingsTarget[],
) {
  const first = targets[0];
  const days = targets.map(
    (target) => resolveWorktreeCleanup(target.settings, null).worktreeDependenciesAfterDays,
  );
  const firstDays = days[0] ?? null;
  const mixedDays = days.some((value) => value !== firstDays);
  const enabled = firstDays !== null;
  const mode = first ? projectCleanupMode(first) : null;
  return {
    mode: targets.every((target) => projectCleanupMode(target) === mode) ? mode : null,
    days: mixedDays ? null : firstDays,
    mixedDays,
    enabled: days.every((value) => (value !== null) === enabled) ? enabled : null,
  };
}

type MobileDependencyCleanupChange =
  | { readonly kind: "days"; readonly value: number | null }
  | { readonly kind: "mode"; readonly value: MobileWorktreeCleanupMode };

/** Complete each project's rules before the scoped planner replaces its override value. */
export function planMobileWorktreeDependencyCleanup(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  change: MobileDependencyCleanupChange,
) {
  if (
    !supportsMobileWorktreeDependencyCleanup(
      targets.map((target) => target.environment),
      projectSelected,
    )
  )
    return [];
  if (change.kind === "mode" && !projectSelected) return [];
  if (change.kind === "days") {
    if (
      change.value !== null &&
      (!Number.isInteger(change.value) ||
        change.value < MIN_MOBILE_RETENTION_DAYS ||
        change.value > MAX_MOBILE_RETENTION_DAYS)
    )
      return [];
    if (projectSelected && targets.some((target) => projectCleanupMode(target) !== "custom"))
      return [];
  }
  if (change.kind === "mode" && change.value === "inherit")
    return planMobileScopedSettingsClear(targets, ["worktreeCleanup"]);

  const writes = new Map<EnvironmentId, ServerSettingsPatch>();
  for (const target of targets) {
    const rules = resolveWorktreeCleanup(target.settings, null);
    const patch: ServerSettingsPatch =
      change.kind === "mode"
        ? {
            worktreeCleanup: change.value === "off" ? { mode: "off" } : { mode: "custom", rules },
          }
        : projectSelected
          ? {
              worktreeCleanup: {
                mode: "custom",
                rules: { ...rules, worktreeDependenciesAfterDays: change.value },
              },
            }
          : {
              storageCleanup: { worktreeDependenciesAfterDays: change.value },
              // Match the active environment policy behavior of the web scoped planner.
              ...(target.settings.worktreeCleanup !== null
                ? {
                    worktreeCleanup: {
                      mode: "custom" as const,
                      rules: { ...rules, worktreeDependenciesAfterDays: change.value },
                    },
                  }
                : {}),
            };
    for (const write of planMobileScopedSettingsPatch([target], projectSelected, patch)) {
      const current = writes.get(write.environmentId);
      writes.set(
        write.environmentId,
        projectSelected
          ? {
              projectSettingsOverrides: {
                ...current?.projectSettingsOverrides,
                ...write.patch.projectSettingsOverrides,
              },
            }
          : write.patch,
      );
    }
  }
  return [...writes].map(([environmentId, patch]) => ({ environmentId, patch }));
}
