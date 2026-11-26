import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";

// Keep config lookup independent of server driver implementations and their adapters.
const BUILT_IN_DRIVER_DEFAULTS: ReadonlyArray<
  Pick<ProviderClientDefinition, "driverKind" | "hasDefaultInstance">
> = [
  { driverKind: ProviderDriverKind.make("codex") },
  { driverKind: ProviderDriverKind.make("claudeAgent") },
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  { driverKind: ProviderDriverKind.make("antigravity") },
  kiroClient,
  piClient,
  museClient,
  acpRegistryClient,
];

export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVER_DEFAULTS) {
    if (driver.hasDefaultInstance === false) continue;
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) continue;
    merged[instanceId] = { driver: driver.driverKind };
  }

  // Probe project-enabled instances even if disabled machine-wide; project threads can still route to them.
  for (const overrides of Object.values(settings.projectSettingsOverrides)) {
    for (const [rawInstanceId, projectOverride] of Object.entries(
      overrides?.providerInstances ?? {},
    )) {
      if (projectOverride.enabled !== true) continue;
      const instanceId = rawInstanceId as ProviderInstanceId;
      const existing = merged[instanceId];
      if (existing === undefined || resolveProviderInstanceEnabled(existing)) continue;
      merged[instanceId] = {
        ...existing,
        enabled: true,
        ...(providerInstanceConfigEnabledFlag(existing.config) === false
          ? { config: { ...(existing.config as Record<string, unknown>), enabled: true } }
          : {}),
      };
    }
  }

  return merged as ProviderInstanceConfigMap;
};
