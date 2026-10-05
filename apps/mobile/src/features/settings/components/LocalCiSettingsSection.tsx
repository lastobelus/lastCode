import {
  DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  type LastCodeLocalCiSettings,
} from "@t3tools/contracts/settings";
import { View } from "react-native";

import { AppText } from "../../../components/AppText";
import { MaterialIconButton } from "../../../components/MaterialIconButton";
import { SettingsControlRow } from "./SettingsControlRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const LIMIT_ROWS = [
  {
    key: "maxConcurrentRuns",
    label: "Concurrent CI runs",
    subtitle: "Additional runs across worktrees wait their turn.",
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
  return (
    <SettingsSection title="Local CI">
      {LIMIT_ROWS.map((row, index) => {
        const value = uniform(row.key);
        const adjust = (amount: number) => {
          const next = Math.max(
            1,
            Math.min(row.max, (value ?? DEFAULT_LASTCODE_LOCAL_CI_SETTINGS[row.key]) + amount),
          );
          if (next !== value) props.onChange({ [row.key]: next });
        };
        return (
          <View key={row.key} className={index > 0 ? "border-t border-border-subtle" : undefined}>
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
