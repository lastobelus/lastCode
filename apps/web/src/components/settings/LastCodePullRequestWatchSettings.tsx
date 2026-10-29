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
import { searchableSetting } from "./settingsSearch";

export function LastCodePullRequestWatchSettings() {
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
    <SettingsSection title="Pull request watches">
      <SettingsRow
        {...searchableSetting("pr-watch-quiet-deadline")}
        serverScoped
        settingKeys={["lastcodePullRequestWatchQuietMinutes"]}
        mixed={mixed}
        description="Wake a waiting agent once when a watched pull request has had no updates for this many minutes. A requested review still pending after this long is reported as stalled. New waits and waits you restart use the new value; running waits keep their current deadline."
        status={
          !supported
            ? "Update the selected environments to configure watch deadlines."
            : scope.kind === "project" || scope.kind === "checkout"
              ? "Choose an environment to configure its watch deadline."
              : undefined
        }
        resetAction={
          mixed || minutes !== DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES ? (
            <SettingResetButton
              label="PR watch quiet deadline"
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
                <NumberFieldDecrement aria-label="Decrease PR watch quiet minutes" />
                <NumberFieldInput aria-label="PR watch quiet minutes" placeholder="Mixed" />
                <NumberFieldIncrement aria-label="Increase PR watch quiet minutes" />
              </NumberFieldGroup>
            </NumberField>
          </div>
        }
      />
    </SettingsSection>
  );
}
