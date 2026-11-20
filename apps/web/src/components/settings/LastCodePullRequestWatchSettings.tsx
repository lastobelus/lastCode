import { useGT } from "gt-react";
import { DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES } from "@t3tools/contracts";
import { useState } from "react";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function LastCodePullRequestWatchSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const minutes = useScopedSettings((settings) => settings.lastcodePullRequestWatchQuietMinutes);
  const mixed = useScopedSettingsMixed(["lastcodePullRequestWatchQuietMinutes"]);
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const canWrite = useScopedSettingsWriteAllowed();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.pullRequestWatchQuietDeadline === true,
    );
  const disabled = !supported || !canWrite || scope.kind === "project" || scope.kind === "checkout";
  const value = mixed ? null : minutes;
  const [savedValue, setSavedValue] = useState(value);
  const [draft, setDraft] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }
  const save = (value: number) => {
    if (!disabled) updateSettings({ lastcodePullRequestWatchQuietMinutes: value });
  };

  return (
    <SettingsSection title={gt("Pull request watches")}>
      <SettingsRow
        {...searchableSetting("pr-watch-quiet-deadline")}
        serverScoped
        settingKeys={["lastcodePullRequestWatchQuietMinutes"]}
        mixed={mixed}
        description={gt(
          "Wake a waiting agent once after this many minutes without PR updates, and report pending requested reviews as stalled. New and restarted waits use this value; running waits keep their deadline.",
        )}
        status={
          !supported
            ? gt("Update the selected environments to configure watch deadlines.")
            : scope.kind === "project" || scope.kind === "checkout"
              ? gt("Choose an environment to configure its watch deadline.")
              : undefined
        }
        resetAction={
          mixed || minutes !== DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES ? (
            <SettingResetButton
              ariaLabel={gt("Reset PR watch quiet deadline to default")}
              disabled={disabled}
              onClick={() => save(DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES)}
            />
          ) : null
        }
        control={
          <div className="w-36">
            <NumberField
              size="sm"
              min={1}
              max={1440}
              step={1}
              disabled={disabled}
              value={draft}
              onValueChange={setDraft}
              onValueCommitted={(value) => {
                if (value !== null && Number.isInteger(value) && value >= 1 && value <= 1440) {
                  save(value);
                } else {
                  setDraft(savedValue);
                }
              }}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label={gt("Decrease PR watch quiet minutes")} />
                <NumberFieldInput
                  aria-label={gt("PR watch quiet minutes")}
                  placeholder={gt("Mixed", { $context: "values differ across targets" })}
                />
                <NumberFieldIncrement aria-label={gt("Increase PR watch quiet minutes")} />
              </NumberFieldGroup>
            </NumberField>
          </div>
        }
      />
    </SettingsSection>
  );
}
