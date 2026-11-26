import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppTextInput } from "../../../components/ui/AppText";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function StorageCleanupScheduleSection(props: {
  readonly settings: ReadonlyArray<ServerSettings["storageCleanupSchedule"]>;
  readonly timeMachineAvailable: boolean;
  readonly disabled: boolean;
  readonly managed: (path: string) => string | undefined;
  readonly onChange: (patch: NonNullable<ServerSettingsPatch["storageCleanupSchedule"]>) => void;
}) {
  const gt = useGT();
  const uniform = <K extends keyof ServerSettings["storageCleanupSchedule"]>(key: K) => {
    const first = props.settings[0]?.[key];
    return first !== undefined && props.settings.every((settings) => settings[key] === first)
      ? first
      : null;
  };
  const minutes = uniform("intervalMinutes");
  const [savedMinutes, setSavedMinutes] = useState(minutes);
  const [draft, setDraft] = useState<string | null>(null);
  if (savedMinutes !== minutes) {
    setSavedMinutes(minutes);
    setDraft(null);
  }
  const intervalLabel = gt("Minutes between cleanups");
  const intervalManaged = props.managed("storageCleanupSchedule.intervalMinutes");
  const intervalDisabled = props.disabled || intervalManaged !== undefined;
  const switches = [
    {
      key: "alternateGroups" as const,
      icon: "arrow.clockwise" as const,
      label: gt("Alternate what gets cleaned"),
      description: gt(
        "Clean dependencies and build outputs on one run, and everything else on the next.",
      ),
    },
    ...(props.timeMachineAvailable
      ? [
          {
            key: "deferDuringTimeMachine" as const,
            icon: "archivebox" as const,
            label: gt("Wait for Time Machine"),
            description: gt("Hold automatic cleanup until a Time Machine backup finishes."),
          },
        ]
      : []),
  ];
  return (
    <SettingsSection title={gt("Automatic cleanup")}>
      <ListRowLayout
        icon="clock"
        label={intervalLabel}
        {...(intervalManaged === undefined ? {} : { description: intervalManaged })}
        disabled={intervalDisabled}
        accessory={
          <AppTextInput
            className="min-h-11 w-24 rounded-xl px-3 py-2 text-center text-base"
            keyboardType="number-pad"
            returnKeyType="done"
            accessibilityLabel={intervalLabel}
            editable={!intervalDisabled}
            value={draft ?? (minutes === null ? "" : String(minutes))}
            placeholder={
              minutes === null
                ? gt("Mixed", { $context: "selected retention settings differ" })
                : undefined
            }
            onChangeText={setDraft}
            onEndEditing={({ nativeEvent }) => {
              setDraft(null);
              const value = Number(nativeEvent.text);
              if (
                !intervalDisabled &&
                Number.isSafeInteger(value) &&
                value > 0 &&
                value !== minutes
              )
                props.onChange({ intervalMinutes: value });
            }}
          />
        }
      />
      {switches.map(({ key, icon, label, description }) => {
        const managed = props.managed(`storageCleanupSchedule.${key}`);
        return (
          <View key={key} className="border-t border-border-subtle">
            <SettingsSwitchRow
              icon={icon}
              label={label}
              subtitle={
                managed === undefined
                  ? description
                  : gt("{subtitle} {reason}", { subtitle: description, reason: managed })
              }
              disabled={props.disabled || managed !== undefined}
              value={uniform(key)}
              onValueChange={(checked) => props.onChange({ [key]: checked })}
            />
          </View>
        );
      })}
    </SettingsSection>
  );
}
