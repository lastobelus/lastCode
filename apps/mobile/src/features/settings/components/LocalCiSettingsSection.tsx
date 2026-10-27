import {
  DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  LastCodeQuickCiMode,
  type LastCodeLocalCiSettings,
} from "@t3tools/contracts/settings";
import { View } from "react-native";

import { AppText } from "../../../components/AppText";
import { MaterialIconButton } from "../../../components/MaterialIconButton";
import { SettingsControlRow } from "./SettingsControlRow";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const QUICK_CI_MODES = {
  auto: { label: "Automatic", description: "Use free local capacity, otherwise defer to GitHub." },
  local: { label: "Always local", description: "Wait for local capacity before running Quick CI." },
  github: { label: "GitHub only", description: "Skip local Quick CI and use GitHub checks." },
} satisfies Record<LastCodeQuickCiMode, { label: string; description: string }>;

const LIMIT_ROWS = [
  {
    key: "maxConcurrentRuns",
    label: "Concurrent CI runs",
    subtitle: "Automatic defers to GitHub when busy; explicit local runs wait.",
    max: 4,
  },
  {
    key: "packageConcurrency",
    label: "Packages checked at once",
    subtitle: "Packages checked in parallel within each run.",
    max: 8,
  },
  {
    key: "compilerThreads",
    label: "TypeScript compiler CPU limit",
    subtitle: "Native TypeScript compiler CPU parallelism within each run.",
    max: 16,
  },
] as const;

export function LocalCiSettingsSection(props: {
  readonly settings: readonly LastCodeLocalCiSettings[];
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<LastCodeLocalCiSettings>) => void;
}) {
  const uniform = <K extends keyof LastCodeLocalCiSettings>(key: K) => {
    const first = props.settings[0];
    return first && props.settings.every((settings) => settings[key] === first[key])
      ? first[key]
      : null;
  };
  const quickCiMode = uniform("quickCiMode");
  return (
    <SettingsSection title="Local CI">
      <View className="gap-1 px-4 py-3">
        <AppText className="text-base text-foreground">
          Quick CI mode{quickCiMode === null ? " · Mixed" : ""}
        </AppText>
        <AppText className="text-sm text-foreground-muted">
          GitHub checks remain required to merge.
        </AppText>
      </View>
      {LastCodeQuickCiMode.literals.map((mode) => (
        <SettingsChoiceRow
          key={mode}
          {...QUICK_CI_MODES[mode]}
          selected={quickCiMode === mode}
          separated
          disabled={props.disabled}
          onPress={() => props.onChange({ quickCiMode: mode })}
        />
      ))}
      {LIMIT_ROWS.map((row) => {
        const value = uniform(row.key);
        const adjust = (amount: number) => {
          const next = Math.max(
            1,
            Math.min(row.max, (value ?? DEFAULT_LASTCODE_LOCAL_CI_SETTINGS[row.key]) + amount),
          );
          if (next !== value) props.onChange({ [row.key]: next });
        };
        return (
          <View key={row.key} className="border-t border-border-subtle">
            <SettingsControlRow
              icon="slider.horizontal.3"
              label={row.label}
              subtitle={row.subtitle}
              disabled={props.disabled}
            >
              <View className="shrink-0 flex-row items-center">
                <MaterialIconButton
                  icon="minus"
                  accessibilityLabel={`Decrease ${row.label.toLowerCase()}`}
                  disabled={props.disabled || value === 1}
                  onPress={() => adjust(-1)}
                />
                <AppText
                  className="min-w-8 text-center text-base"
                  accessibilityLabel={`${row.label}: ${value ?? "Mixed"}`}
                  accessibilityLiveRegion="polite"
                >
                  {value ?? "Mixed"}
                </AppText>
                <MaterialIconButton
                  icon="plus"
                  accessibilityLabel={`Increase ${row.label.toLowerCase()}`}
                  disabled={props.disabled || value === row.max}
                  onPress={() => adjust(1)}
                />
              </View>
            </SettingsControlRow>
          </View>
        );
      })}
      <View className="border-t border-border-subtle">
        <SettingsSwitchRow
          icon="slider.horizontal.3"
          label="Background CI priority"
          subtitle="Use a lower CPU priority to keep the app responsive. Applies to new runs."
          value={uniform("backgroundPriority")}
          disabled={props.disabled}
          onValueChange={(backgroundPriority) => props.onChange({ backgroundPriority })}
        />
      </View>
    </SettingsSection>
  );
}
