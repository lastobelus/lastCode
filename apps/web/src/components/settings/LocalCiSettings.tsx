import {
  DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  LastCodeQuickCiMode,
  type LastCodeLocalCiSettings,
} from "@t3tools/contracts/settings";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const QUICK_CI_MODES = {
  auto: "Automatic",
  local: "Always local",
  github: "GitHub only",
} satisfies Record<LastCodeQuickCiMode, string>;

const LIMIT_ROWS = [
  {
    key: "maxConcurrentRuns",
    id: "local-ci-runs",
    title: "Concurrent CI runs",
    description:
      "Limit local CI runs across worktrees on this machine. Automatic defers to GitHub when busy; explicit local runs wait.",
    max: 4,
  },
  {
    key: "packageConcurrency",
    id: "local-ci-packages",
    title: "Packages checked at once",
    description: "Limit packages checked in parallel within each CI run.",
    max: 8,
  },
  {
    key: "compilerThreads",
    id: "local-ci-compiler-cpu",
    title: "TypeScript compiler CPU limit",
    description: "Limit native TypeScript compiler CPU parallelism within each CI run.",
    max: 16,
  },
] as const;

function LocalCiLimitField(props: {
  readonly label: string;
  readonly value: number | null;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  const [savedValue, setSavedValue] = useState(props.value);
  const [draft, setDraft] = useState(props.value);
  if (savedValue !== props.value) {
    setSavedValue(props.value);
    setDraft(props.value);
  }
  return (
    <div className="w-36">
      <NumberField
        size="sm"
        min={1}
        max={props.max}
        step={1}
        value={draft}
        onValueChange={setDraft}
        onValueCommitted={(value) => {
          if (value !== null && Number.isInteger(value) && value >= 1 && value <= props.max) {
            props.onChange(value);
          } else {
            setDraft(props.value);
          }
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${props.label.toLowerCase()}`} />
          <NumberFieldInput aria-label={props.label} placeholder="Mixed" />
          <NumberFieldIncrement aria-label={`Increase ${props.label.toLowerCase()}`} />
        </NumberFieldGroup>
      </NumberField>
    </div>
  );
}

export function LocalCiSettingsSection() {
  const settings = useScopedSettings((settings) => settings.lastcodeLocalCi);
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments, targets } = useSettingsScope();
  const supportsLocalCi =
    targets.length > 0 &&
    connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.capabilities.lastcodeLocalCi === true,
    );
  const mixed = (key: keyof LastCodeLocalCiSettings) =>
    targets.some((target) => target.settings.lastcodeLocalCi[key] !== settings[key]);
  const patch = (value: Partial<LastCodeLocalCiSettings>) => {
    if (supportsLocalCi) updateSettings({ lastcodeLocalCi: value });
  };

  if (!supportsLocalCi) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.lastcodeLocalCi === true,
          )
          .map((environment) => environment.environmentId)}
      >
        Update the selected environments to configure Local CI, or choose a connected environment
        that supports it.
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsSection title="Local CI" icon={<GaugeIcon className="size-5" />}>
      <SettingsRow
        {...searchableSetting("local-ci-quick-mode")}
        description="Automatic uses free local capacity, otherwise defers to GitHub. Always local waits for capacity. GitHub checks remain required to merge."
        serverScoped
        settingKeys={["lastcodeLocalCi"]}
        mixed={mixed("quickCiMode")}
        resetAction={
          mixed("quickCiMode") ||
          settings.quickCiMode !== DEFAULT_LASTCODE_LOCAL_CI_SETTINGS.quickCiMode ? (
            <SettingResetButton
              label="Quick CI mode"
              onClick={() => patch({ quickCiMode: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS.quickCiMode })}
            />
          ) : null
        }
        control={
          <Select
            value={mixed("quickCiMode") ? null : settings.quickCiMode}
            onValueChange={(value) => {
              if (LastCodeQuickCiMode.literals.includes(value as LastCodeQuickCiMode)) {
                patch({ quickCiMode: value as LastCodeQuickCiMode });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Quick CI mode">
              <SelectValue>
                {(value: LastCodeQuickCiMode | null) =>
                  value === null ? "Mixed" : QUICK_CI_MODES[value]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {LastCodeQuickCiMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {QUICK_CI_MODES[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {LIMIT_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          {...searchableSetting(row.id)}
          description={row.description}
          serverScoped
          settingKeys={["lastcodeLocalCi"]}
          mixed={mixed(row.key)}
          resetAction={
            mixed(row.key) || settings[row.key] !== DEFAULT_LASTCODE_LOCAL_CI_SETTINGS[row.key] ? (
              <SettingResetButton
                label={row.title.toLowerCase()}
                onClick={() => patch({ [row.key]: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS[row.key] })}
              />
            ) : null
          }
          control={
            <LocalCiLimitField
              label={row.title}
              max={row.max}
              value={mixed(row.key) ? null : settings[row.key]}
              onChange={(value) => patch({ [row.key]: value })}
            />
          }
        />
      ))}
      <SettingsRow
        {...searchableSetting("local-ci-background-priority")}
        description="Run CI at a lower CPU priority so agents and the app stay responsive. Applies to new CI runs."
        serverScoped
        settingKeys={["lastcodeLocalCi"]}
        mixed={mixed("backgroundPriority")}
        control={
          <Switch
            mixed={mixed("backgroundPriority")}
            checked={mixed("backgroundPriority") ? false : settings.backgroundPriority}
            onCheckedChange={(checked) => patch({ backgroundPriority: Boolean(checked) })}
            aria-label="Background CI priority"
          />
        }
      />
    </SettingsSection>
  );
}
