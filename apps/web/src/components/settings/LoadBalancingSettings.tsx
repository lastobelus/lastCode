import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import type { MessageResolver } from "~/i18n/messages";
import type { EnvironmentPresentation } from "~/state/environments";
import { loadBalancingDecisionLog } from "~/lib/loadBalancingDiagnostics";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { useSearchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: msg("Prefer") },
  { value: 50, label: msg("Normal", { $context: "load balancing preference" }) },
  { value: 25, label: msg("Less often") },
  { value: 0, label: msg("Manual only") },
] as const;

const summaryLabels = {
  100: msg("{environment} prefer"),
  25: msg("{environment} less often"),
  0: msg("{environment} manual only"),
} as const;

type LoadPreference = (typeof preferences)[number]["value"];

function loadPreferenceForWeight(weight: number | undefined): LoadPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}

function summarizeLoadPreferences(
  environments: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label">>,
  weights: Readonly<Record<string, number>>,
  resolve: MessageResolver,
): string | null {
  const parts = environments.flatMap((environment) => {
    const preference = loadPreferenceForWeight(weights[environment.environmentId]);
    return preference === 50
      ? []
      : [resolve(summaryLabels[preference], { environment: environment.label })];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const searchableSetting = useSearchableSetting();
  const settings = useClientSettings((current) => ({
    loadBalancingEnabled: current.loadBalancingEnabled,
    loadBalancingWeights: current.loadBalancingWeights,
  }));
  const settingsHydrated = useClientSettingsHydrated();
  const gt = useGT();
  const m = useMessages();
  const items = preferences.map((entry) => ({ ...entry, label: m(entry.label) }));
  const decisionLog = useSyncExternalStore(
    loadBalancingDecisionLog.subscribe,
    loadBalancingDecisionLog.getSnapshot,
  );
  const [now, setNow] = useState(Date.now);
  const logging = decisionLog.expiresAt > now;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns a browser timeout to update the logging indicator when the external decision-log session expires
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
      toastManager.add({
        type: "error",
        title: gt("Could not save Auto balance logging settings"),
      });
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
          ? summarizeLoadPreferences(environments, settings.loadBalancingWeights, m)
          : gt("Off", { $context: "load balancing is turned off" })
      }
      control={
        <Switch
          aria-label={gt("Automatically balance load")}
          checked={settings.loadBalancingEnabled}
          disabled={!settingsHydrated}
          onCheckedChange={(loadBalancingEnabled) => updateClientSettings({ loadBalancingEnabled })}
        />
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          New threads in shared projects go to the highest score: spare CPU capacity ×
          available-memory percentage × preference. Prefer gives a machine twice the weight of
          Normal. CPU capacity includes logical core count. Existing threads stay on their machine.
        </T>
      </p>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={<EnvironmentTransportLabel environment={environment} />}
        >
          <Select
            items={items}
            value={loadPreferenceForWeight(
              settings.loadBalancingWeights[environment.environmentId],
            )}
            disabled={!settingsHydrated || !settings.loadBalancingEnabled}
            onValueChange={(value) => {
              if (value === null) return;
              updateClientSettings({
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
              aria-label={gt("{environment} load preference", { environment: environment.label })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {items.map(({ value, label }) => (
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
          {logging ? gt("Stop logging") : gt("Log decisions for 24 hours")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={downloadDecisions}
          disabled={decisionLog.records.length === 0}
        >
          <T>Download decision logs</T>
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          {logging
            ? `${gt("Logging until {time}.", {
                time: new Date(decisionLog.expiresAt).toLocaleString(),
              })} `
            : ""}
          {gt(
            "{count} decisions saved on this device. Keeps the latest 200, including scores and excluded machines.",
            { count: decisionLog.records.length },
          )}
        </p>
      </div>
    </FoldedSettingsSection>
  );
}
