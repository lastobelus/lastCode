import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { loadBalancingDecisionLog } from "~/lib/loadBalancingDiagnostics";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
] as const;

type LoadPreference = (typeof preferences)[number]["value"];

/** Snaps a saved weight (older builds stored a slider value) onto the four preferences. */
export function loadPreferenceForWeight(weight: number | undefined): LoadPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}

function preferenceLabel(preference: LoadPreference): string {
  return preferences.find((entry) => entry.value === preference)!.label;
}

/**
 * Closed-header summary: the machines not at Normal, so the folded section
 * still tells you what is set. Null when every machine is at the default.
 */
export function summarizeLoadPreferences(
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label">>,
  weights: Readonly<Record<string, number>>,
): string | null {
  const parts = environments.flatMap((environment) => {
    const preference = loadPreferenceForWeight(weights[environment.environmentId]);
    return preference === 50
      ? []
      : [`${environment.label} ${preferenceLabel(preference).toLowerCase()}`];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * Folded section under the environments list. Its switch turns balancing on
 * for this client, and the body holds one row per switched-on machine with
 * how often that machine should receive new threads. Rendered only when two
 * or more machines are on, since one machine has nothing to balance against.
 */
export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const settings = useClientSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  const decisionLog = useSyncExternalStore(
    loadBalancingDecisionLog.subscribe,
    loadBalancingDecisionLog.getSnapshot,
  );
  const [now, setNow] = useState(Date.now);
  const logging = decisionLog.expiresAt > now;
  useEffect(() => {
    if (decisionLog.expiresAt === 0) return;
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, decisionLog.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [decisionLog.expiresAt]);
  const changeLogging = () => {
    try {
      if (logging) loadBalancingDecisionLog.stop();
      else loadBalancingDecisionLog.start();
    } catch {
      toastManager.add({ type: "error", title: "Could not save Auto balance logging settings" });
    }
  };
  const downloadDecisions = () => {
    const url = URL.createObjectURL(
      new Blob([loadBalancingDecisionLog.export()], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "auto-balance-decisions.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        settings.loadBalancingEnabled
          ? summarizeLoadPreferences(environments, settings.loadBalancingWeights)
          : "Off"
      }
      control={
        <Switch
          aria-label="Automatically balance load"
          checked={settings.loadBalancingEnabled}
          disabled={!settingsHydrated}
          onCheckedChange={(loadBalancingEnabled) => updateSettings({ loadBalancingEnabled })}
        />
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        New threads in shared projects go to the highest score: spare CPU capacity ×
        available-memory percentage × preference. Prefer gives a machine twice the weight of Normal.
        CPU capacity includes logical core count. Existing threads stay on their machine.
      </p>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={environmentTransportLabel(environment)}
        >
          <Select
            items={preferences}
            value={loadPreferenceForWeight(
              settings.loadBalancingWeights[environment.environmentId],
            )}
            disabled={!settingsHydrated || !settings.loadBalancingEnabled}
            onValueChange={(value) => {
              if (value === null) return;
              updateSettings({
                loadBalancingWeights: {
                  ...settings.loadBalancingWeights,
                  [environment.environmentId]: value,
                },
              });
            }}
          >
            <SelectTrigger
              size="xs"
              className="w-32"
              aria-label={`${environment.label} load preference`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {preferences.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </EnvironmentRow>
      ))}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <Button variant="outline" size="sm" onClick={changeLogging}>
          {logging ? "Stop logging" : "Log decisions for 24 hours"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={downloadDecisions}
          disabled={decisionLog.records.length === 0}
        >
          Download decision logs
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          {logging ? `Logging until ${new Date(decisionLog.expiresAt).toLocaleString()}. ` : ""}
          {decisionLog.records.length} decisions saved on this device. Keeps the latest 200,
          including scores and excluded machines.
        </p>
      </div>
    </FoldedSettingsSection>
  );
}
