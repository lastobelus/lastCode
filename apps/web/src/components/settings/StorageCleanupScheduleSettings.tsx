import { useGT } from "gt-react";
import { useState } from "react";

import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function StorageCleanupScheduleSettings() {
  const gt = useGT();
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings((value) => value.storageCleanupSchedule);
  const update = useUpdateScopedSettings();
  const mixed = (key: keyof typeof settings) =>
    targets.some((target) => target.settings.storageCleanupSchedule[key] !== settings[key]);
  const intervalMixed = mixed("intervalMinutes");
  const shownInterval = intervalMixed ? null : settings.intervalMinutes;
  const [savedInterval, setSavedInterval] = useState(shownInterval);
  const [draft, setDraft] = useState(shownInterval);
  if (savedInterval !== shownInterval) {
    setSavedInterval(shownInterval);
    setDraft(shownInterval);
  }
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (target) => target.serverConfig?.environment.capabilities.storageCleanupScheduling !== true,
    )
  )
    return null;
  const timeMachineAvailable = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.platform.os === "darwin",
  );
  const intervalLabel = gt("Minutes between cleanups");
  const switches = [
    {
      key: "alternateGroups" as const,
      label: gt("Alternate what gets cleaned"),
      description: gt(
        "Clean dependencies and build outputs on one run, and everything else on the next.",
      ),
    },
    ...(timeMachineAvailable
      ? [
          {
            key: "deferDuringTimeMachine" as const,
            label: gt("Wait for Time Machine"),
            description: gt("Hold automatic cleanup until a Time Machine backup finishes."),
          },
        ]
      : []),
  ];
  return (
    <SettingsSection id="storage-cleanup-schedule" title={gt("Automatic cleanup")}>
      <SettingsRow
        title={intervalLabel}
        serverScoped
        managedPaths={["storageCleanupSchedule.intervalMinutes"]}
        mixed={intervalMixed}
        control={
          <div className="w-24">
            <NumberField
              size="sm"
              min={1}
              step={1}
              value={draft}
              onValueChange={setDraft}
              onValueCommitted={(value) => {
                if (value === null || !Number.isSafeInteger(value) || value < 1) {
                  setDraft(savedInterval);
                } else if (shownInterval !== value) {
                  update(
                    { storageCleanupSchedule: { intervalMinutes: value } },
                    { onFailed: () => setDraft(savedInterval) },
                  );
                }
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label={intervalLabel} />
              </NumberFieldGroup>
            </NumberField>
          </div>
        }
      />
      {switches.map(({ key, label, description }) => (
        <SettingsRow
          key={key}
          title={label}
          description={description}
          serverScoped
          managedPaths={[`storageCleanupSchedule.${key}`]}
          mixed={mixed(key)}
          control={
            <Switch
              aria-label={label}
              checked={!mixed(key) && settings[key]}
              onCheckedChange={(checked) => update({ storageCleanupSchedule: { [key]: checked } })}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}
