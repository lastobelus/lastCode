import {
  DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  LastCodeQuickCiMode,
  type LastCodeLocalCiSettings,
} from "@t3tools/contracts/settings";
import { msg, useGT, useMessages } from "gt-react";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironments } from "../../state/environments";
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
import { SettingsScopeNoticeContent } from "./SettingsScopeNotice";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const QUICK_CI_MODES = {
  auto: msg("Automatic", { $context: "Quick CI mode" }),
  local: msg("Always local", { $context: "Quick CI mode" }),
  github: msg("{host} only", { $context: "Quick CI mode", host: "GitHub" }),
} satisfies Record<LastCodeQuickCiMode, string>;

const LIMIT_ROWS = [
  {
    key: "maxConcurrentRuns",
    id: "local-ci-runs",
    description: msg(
      "Limit local CI runs across worktrees on this machine. Automatic defers to {host} when busy; explicit local runs wait.",
      { host: "GitHub" },
    ),
    max: 4,
  },
  {
    key: "packageConcurrency",
    id: "local-ci-packages",
    description: msg("Limit packages checked in parallel within each CI run."),
    max: 8,
  },
  {
    key: "compilerThreads",
    id: "local-ci-compiler-cpu",
    description: msg("Limit native {language} compiler CPU parallelism within each CI run.", {
      language: "TypeScript",
    }),
    max: 16,
  },
] as const;

function LocalCiLimitField(props: {
  readonly label: string;
  readonly value: number | null;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  const gt = useGT();
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
          <NumberFieldDecrement
            aria-label={gt("Decrease {label}", { label: props.label.toLowerCase() })}
          />
          <NumberFieldInput
            aria-label={props.label}
            placeholder={gt("Mixed", { $context: "selected Local CI settings differ" })}
          />
          <NumberFieldIncrement
            aria-label={gt("Increase {label}", { label: props.label.toLowerCase() })}
          />
        </NumberFieldGroup>
      </NumberField>
    </div>
  );
}

export function LocalCiSettingsSection() {
  const gt = useGT();
  return (
    <SettingsSection title={gt("Local CI")} icon={<GaugeIcon className="size-5" />}>
      <LocalCiSettingsContent />
    </SettingsSection>
  );
}

function LocalCiSettingsContent() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const resolve = useMessages();
  const settings = useScopedSettings((settings) => settings.lastcodeLocalCi);
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const eligibleEnvironmentIds = environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.lastcodeLocalCi === true,
    )
    .map((environment) => environment.environmentId);
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

  if (scope.kind === "project" || scope.kind === "checkout") {
    return (
      <SettingsScopeNoticeContent
        target="environment"
        eligibleEnvironmentIds={eligibleEnvironmentIds}
      >
        {gt(
          "Local CI settings apply to all projects on an environment. Choose a connected environment that supports Local CI to configure them.",
        )}
      </SettingsScopeNoticeContent>
    );
  }

  if (!supportsLocalCi) {
    return (
      <SettingsScopeNoticeContent
        target="environment"
        eligibleEnvironmentIds={eligibleEnvironmentIds}
      >
        {gt(
          "Update the selected environments to configure Local CI, or choose a connected environment that supports it.",
        )}
      </SettingsScopeNoticeContent>
    );
  }

  return (
    <>
      <SettingsRow
        {...searchableSetting("local-ci-quick-mode")}
        description={gt(
          "Automatic uses free local capacity, otherwise defers to {host}. Always local waits for capacity. {host} checks remain required to merge.",
          { host: "GitHub" },
        )}
        serverScoped
        settingKeys={["lastcodeLocalCi"]}
        mixed={mixed("quickCiMode")}
        resetAction={
          mixed("quickCiMode") ||
          settings.quickCiMode !== DEFAULT_LASTCODE_LOCAL_CI_SETTINGS.quickCiMode ? (
            <SettingResetButton
              ariaLabel={gt("Reset Quick CI mode to default")}
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
            <SelectTrigger size="sm" aria-label={gt("Quick CI mode")}>
              <SelectValue>
                {(value: LastCodeQuickCiMode | null) =>
                  value === null
                    ? gt("Mixed", { $context: "selected Local CI settings differ" })
                    : resolve(QUICK_CI_MODES[value])
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {LastCodeQuickCiMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {resolve(QUICK_CI_MODES[mode])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {LIMIT_ROWS.map((row) => {
        const setting = searchableSetting(row.id);
        return (
          <SettingsRow
            key={row.key}
            {...setting}
            description={resolve(row.description)}
            serverScoped
            settingKeys={["lastcodeLocalCi"]}
            mixed={mixed(row.key)}
            resetAction={
              mixed(row.key) ||
              settings[row.key] !== DEFAULT_LASTCODE_LOCAL_CI_SETTINGS[row.key] ? (
                <SettingResetButton
                  ariaLabel={gt("Reset {label} to default", {
                    label: setting.title.toLowerCase(),
                  })}
                  onClick={() => patch({ [row.key]: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS[row.key] })}
                />
              ) : null
            }
            control={
              <LocalCiLimitField
                label={setting.title}
                max={row.max}
                value={mixed(row.key) ? null : settings[row.key]}
                onChange={(value) => patch({ [row.key]: value })}
              />
            }
          />
        );
      })}
      <SettingsRow
        {...searchableSetting("local-ci-background-priority")}
        description={gt(
          "Run CI at a lower CPU priority so agents and the app stay responsive. Applies to new CI runs.",
        )}
        serverScoped
        settingKeys={["lastcodeLocalCi"]}
        mixed={mixed("backgroundPriority")}
        control={
          <Switch
            mixed={mixed("backgroundPriority")}
            checked={mixed("backgroundPriority") ? false : settings.backgroundPriority}
            onCheckedChange={(checked) => patch({ backgroundPriority: Boolean(checked) })}
            aria-label={gt("Background CI priority")}
          />
        }
      />
    </>
  );
}
