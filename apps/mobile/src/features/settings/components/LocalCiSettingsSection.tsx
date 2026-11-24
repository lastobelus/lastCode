import {
  DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  LastCodeQuickCiMode,
  type LastCodeLocalCiSettings,
} from "@t3tools/contracts/settings";
import { msg, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText } from "../../../components/ui/AppText";
import { IconButton } from "../../../components/ui/IconButton";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const QUICK_CI_MODES = {
  auto: {
    label: msg("Automatic", { $context: "Quick CI mode" }),
    description: msg("Use free local capacity, otherwise defer to {host}.", { host: "GitHub" }),
  },
  local: {
    label: msg("Always local", { $context: "Quick CI mode" }),
    description: msg("Wait for local capacity before running {check}.", { check: "Quick CI" }),
  },
  github: {
    label: msg("{host} only", { $context: "Quick CI mode", host: "GitHub" }),
    description: msg("Skip local {check} and use {host} checks.", {
      check: "Quick CI",
      host: "GitHub",
    }),
  },
} satisfies Record<LastCodeQuickCiMode, { label: string; description: string }>;

const LIMIT_ROWS = [
  {
    key: "maxConcurrentRuns",
    label: msg("Concurrent CI runs"),
    subtitle: msg("Automatic defers to {host} when busy; explicit local runs wait.", {
      host: "GitHub",
    }),
    decreaseLabel: msg("Decrease concurrent CI runs"),
    increaseLabel: msg("Increase concurrent CI runs"),
    max: 4,
  },
  {
    key: "packageConcurrency",
    label: msg("Packages checked at once"),
    subtitle: msg("Packages checked in parallel within each run."),
    decreaseLabel: msg("Decrease packages checked at once"),
    increaseLabel: msg("Increase packages checked at once"),
    max: 8,
  },
  {
    key: "compilerThreads",
    label: msg("{language} compiler CPU limit", { language: "TypeScript" }),
    subtitle: msg("Native {language} compiler CPU parallelism within each run.", {
      language: "TypeScript",
    }),
    decreaseLabel: msg("Decrease {language} compiler cpu limit", { language: "typescript" }),
    increaseLabel: msg("Increase {language} compiler cpu limit", { language: "typescript" }),
    max: 16,
  },
] as const;

export function LocalCiSettingsSection(props: {
  readonly settings: readonly LastCodeLocalCiSettings[];
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<LastCodeLocalCiSettings>) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const uniform = <K extends keyof LastCodeLocalCiSettings>(key: K) => {
    const first = props.settings[0];
    return first && props.settings.every((settings) => settings[key] === first[key])
      ? first[key]
      : null;
  };
  const quickCiMode = uniform("quickCiMode");
  return (
    <SettingsSection title={gt("Local CI")}>
      <View className="gap-1 px-4 py-3">
        <AppText className="text-base text-foreground">
          {quickCiMode === null
            ? gt("{check} mode · Mixed", { check: "Quick CI" })
            : gt("{check} mode", { check: "Quick CI" })}
        </AppText>
        <AppText className="text-sm text-foreground-muted">
          {gt("{host} checks remain required to merge.", { host: "GitHub" })}
        </AppText>
      </View>
      {LastCodeQuickCiMode.literals.map((mode) => (
        <ListChoiceRow
          key={mode}
          label={resolve(QUICK_CI_MODES[mode].label)}
          description={resolve(QUICK_CI_MODES[mode].description)}
          selected={quickCiMode === mode}
          separated
          disabled={props.disabled}
          onPress={() => props.onChange({ quickCiMode: mode })}
        />
      ))}
      {LIMIT_ROWS.map((row) => {
        const value = uniform(row.key);
        const label = resolve(row.label);
        const displayValue =
          value ?? gt("Mixed", { $context: "selected Local CI settings differ" });
        const adjust = (amount: number) => {
          const next = Math.max(
            1,
            Math.min(row.max, (value ?? DEFAULT_LASTCODE_LOCAL_CI_SETTINGS[row.key]) + amount),
          );
          if (next !== value) props.onChange({ [row.key]: next });
        };
        return (
          <View key={row.key} className="border-t border-border-subtle">
            <ListRowLayout
              icon="slider.horizontal.3"
              label={label}
              description={resolve(row.subtitle)}
              disabled={props.disabled}
              accessory={
                <View className="shrink-0 flex-row items-center">
                  <IconButton
                    icon="minus"
                    accessibilityLabel={resolve(row.decreaseLabel)}
                    disabled={props.disabled || value === 1}
                    onPress={() => adjust(-1)}
                  />
                  <AppText
                    className="min-w-8 text-center text-base"
                    accessibilityLabel={gt("{label}: {value}", { label, value: displayValue })}
                    accessibilityLiveRegion="polite"
                  >
                    {displayValue}
                  </AppText>
                  <IconButton
                    icon="plus"
                    accessibilityLabel={resolve(row.increaseLabel)}
                    disabled={props.disabled || value === row.max}
                    onPress={() => adjust(1)}
                  />
                </View>
              }
            />
          </View>
        );
      })}
      <View className="border-t border-border-subtle">
        <SettingsSwitchRow
          icon="slider.horizontal.3"
          label={gt("Background CI priority")}
          subtitle={gt("Use a lower CPU priority to keep the app responsive. Applies to new runs.")}
          value={uniform("backgroundPriority")}
          disabled={props.disabled}
          onValueChange={(backgroundPriority) => props.onChange({ backgroundPriority })}
        />
      </View>
    </SettingsSection>
  );
}
