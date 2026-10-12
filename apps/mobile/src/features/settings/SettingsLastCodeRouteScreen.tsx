import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export function SettingsLastCodeRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const targets = useMemo(
    () =>
      resolveMobileSettingsTargets(
        selectedTargets.filter(
          (target) => target.serverConfig.environment.capabilities.environmentPause === true,
        ),
        null,
      ),
    [selectedTargets],
  );
  const canWrite = useAtomValue(
    useMemo(
      () =>
        Atom.make(
          (get) =>
            targets.length > 0 &&
            targets.every((target) =>
              get(
                serverEnvironment.updateSettings.permissionAtom(target.environment.environmentId),
              ),
            ),
        ),
      [targets],
    ),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "LastCode settings update",
    reportFailure: false,
  });
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const displayTargets = pendingTargets ?? targets;

  async function setPauseEnabled(environmentPauseEnabled: boolean) {
    if (
      writeInFlight.current ||
      !canWrite ||
      !targets.every((target) =>
        appAtomRegistry.get(
          serverEnvironment.updateSettings.permissionAtom(target.environment.environmentId),
        ),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(targets, false, { environmentPauseEnabled });
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setError(null);
    try {
      const outcomes = await Promise.allSettled(
        writes.map(async (entry) => {
          const result = await updateSettings({
            environmentId: entry.environmentId,
            input: { patch: entry.patch },
          });
          if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
        }),
      );
      const failures = outcomes.flatMap((result, index) => {
        if (result.status === "fulfilled") return [];
        const label = targets[index]!.environment.label;
        const message =
          result.reason instanceof Error ? result.reason.message : "Could not save settings.";
        return [`${label}: ${message}`];
      });
      if (failures.length > 0) setError(failures.join("\n"));
    } finally {
      writeInFlight.current = false;
      setPendingTargets(null);
    }
  }

  return (
    <>
      <SettingsEnvironmentFilterHeader environmentOnly />
      <SettingsScreen
        title="LastCode"
        trailing={<AndroidSettingsEnvironmentFilter environmentOnly />}
      >
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {displayTargets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              {selectedTargets.length === 0
                ? "Use the filter above to select a connected environment."
                : "Environment pause is not supported by the selected environments."}
            </Text>
          ) : (
            <>
              <SettingsSection title="Pause to go offline">
                <SettingsSwitchRow
                  icon="pause"
                  label="Show environment pause button"
                  subtitle="Ask active threads to pause, wait for quiet, then resume the same threads."
                  value={uniformMobileSetting(displayTargets, "environmentPauseEnabled")}
                  disabled={!canWrite || pendingTargets !== null}
                  onValueChange={(enabled) => void setPauseEnabled(enabled)}
                />
              </SettingsSection>
              <Text className="px-2 text-sm text-foreground-muted">
                Applies to {displayTargets.map((target) => target.environment.label).join(", ")}.{" "}
                This setting applies to the whole environment.
              </Text>
              {!canWrite ? (
                <Text className="px-2 text-sm text-foreground-muted">
                  This connection does not have permission to change settings on every selected
                  environment.
                </Text>
              ) : null}
            </>
          )}
          {pendingTargets !== null ? (
            <Text accessibilityLiveRegion="polite" className="px-2 text-sm text-foreground-muted">
              Saving…
            </Text>
          ) : null}
          {error ? (
            <Text
              accessibilityRole="alert"
              selectable
              className="px-2 text-sm text-danger-foreground"
            >
              {error}
            </Text>
          ) : null}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}
