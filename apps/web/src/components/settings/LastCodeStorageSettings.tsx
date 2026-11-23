import {
  MAX_WORKTREE_SUSPENSION_AFTER_DAYS,
  MIN_WORKTREE_SUSPENSION_AFTER_DAYS,
  type WorktreeSuspensionPolicy,
  type WorktreeSuspensionScopes,
} from "@t3tools/contracts/settings";
import { msg, T, useGT, useMessages } from "gt-react";
import { createContext, useContext, useState, type ReactNode } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const EMPTY_SCOPES: WorktreeSuspensionScopes = {
  subagents: false,
  untouchedChildren: false,
  otherThreads: false,
};
const SuspensionGuidanceContext = createContext(false);
const SUSPENSION_MODES = {
  inherit: msg("Inherit", { $context: "use the environment's worktree suspension policy" }),
  off: msg("Off", { $context: "automatic worktree suspension is turned off" }),
  custom: msg("Custom", { $context: "custom worktree suspension policy" }),
} as const;
const SCOPE_ROWS = [
  {
    key: "subagents",
    title: msg("Finished subagents"),
    description: msg(
      "Suspend work that was delegated to a subagent and is now finished. A worktree in use, or one with {keepWorkspace} on, is not suspended.",
      { keepWorkspace: "Keep workspace" },
    ),
  },
  {
    key: "untouchedChildren",
    title: msg("Child threads you haven’t joined"),
    description: msg(
      "Threads an agent started that you haven’t taken part in. Reading one does not count as joining it. If {appName} can’t tell, the worktree stays.",
      { appName: "LastCode" },
    ),
  },
  {
    key: "otherThreads",
    title: msg("Top-level threads and threads you’ve joined"),
    description: msg(
      "Includes threads you created, adopted or participated in, including former subagents. Leave this off so this policy never suspends their worktrees. Other cleanup rules you have turned on can still remove them.",
    ),
  },
] as const;

type PolicySelection = "inherit" | "off" | "custom" | null;

function projectPolicyMode(target: ScopedSettingsTarget | null): PolicySelection {
  return target?.sources.worktreeSuspension === "project"
    ? target.settings.worktreeSuspension.mode
    : "inherit";
}

function inheritedPolicyDescription(
  policy: WorktreeSuspensionPolicy,
  resolve: MessageResolver = m,
) {
  if (policy.mode === "off") {
    return resolve(msg("Inherit the environment’s policy. Automatic suspension is Off."));
  }
  const scopeCount = Object.values(policy.scopes).filter(Boolean).length;
  return scopeCount === 0
    ? resolve(
        msg(
          "Inherit the environment’s policy. No thread types are enabled for automatic suspension.",
        ),
      )
    : resolve(
        msg(
          "Inherit the environment’s policy. Enabled for {scopeCount, plural, one {{scopeCount} thread type} other {{scopeCount} thread types}} after {days, plural, one {{days} day} other {{days} days}} settled or archived and unused.",
          { scopeCount, days: policy.afterDays },
        ),
      );
}

function SuspensionPolicyForm({
  initialMode,
  policy,
  mixed,
  projectScope,
  disabled,
  status,
  savedWorkspaces,
  onSave,
  onInherit,
}: {
  readonly initialMode: PolicySelection;
  readonly policy: WorktreeSuspensionPolicy;
  readonly mixed: boolean;
  readonly projectScope: boolean;
  readonly disabled: boolean;
  readonly status: string | undefined;
  readonly savedWorkspaces?: ReactNode;
  readonly onSave: (policy: WorktreeSuspensionPolicy) => void;
  readonly onInherit: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const searchableSetting = useSearchableSetting();
  const [mode, setMode] = useState(initialMode);
  const [days, setDays] = useState(
    !mixed && policy.mode === "custom" ? String(policy.afterDays) : "",
  );
  const [scopes, setScopes] = useState(
    !mixed && policy.mode === "custom" ? policy.scopes : EMPTY_SCOPES,
  );
  const afterDays = Number(days);
  const validDays =
    days.trim() !== "" &&
    Number.isInteger(afterDays) &&
    afterDays >= MIN_WORKTREE_SUSPENSION_AFTER_DAYS &&
    afterDays <= MAX_WORKTREE_SUSPENSION_AFTER_DAYS;
  const hasScope = Object.values(scopes).some(Boolean);
  const unchanged =
    initialMode === "custom" &&
    !mixed &&
    policy.mode === "custom" &&
    policy.afterDays === afterDays &&
    SCOPE_ROWS.every(({ key }) => policy.scopes[key] === scopes[key]);

  return (
    <SuspensionGuidanceContext
      value={mode === "custom" || (mode === "inherit" && policy.mode === "custom")}
    >
      <SettingsRow
        {...searchableSetting("storage-suspension-policy")}
        description={
          mode === "custom"
            ? gt(
                "Choose how many days to wait and which kinds of threads to include, then save. Your other cleanup rules stay as they are.",
              )
            : mode === "inherit"
              ? mixed
                ? gt("Inherit each selected environment’s policy; their values differ.")
                : inheritedPolicyDescription(policy, resolve)
              : gt(
                  // oxlint-disable-next-line t3code/no-em-dash-copy -- The maintainer explicitly selected this combined explanation and em dash.
                  "Save local work and put away eligible checkouts without archiving the conversation — {appName} saves each worktree’s work on this machine, removes the folder, and restores it when you continue.",
                  { appName: "LastCode" },
                )
        }
        status={status}
        mixed={mixed}
        serverScoped
        settingKeys={["worktreeSuspension"]}
        control={
          <Select
            value={mode}
            disabled={disabled}
            onValueChange={(next) => {
              if (next === "custom") setMode("custom");
              else if (next === "off") {
                setMode("off");
                onSave({ mode: "off" });
              } else if (next === "inherit") {
                setMode("inherit");
                onInherit();
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Suspend worktrees automatically")}>
              <SelectValue>
                {mode === null
                  ? gt("Mixed", { $context: "selected worktree suspension policies differ" })
                  : resolve(SUSPENSION_MODES[mode])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {projectScope && (
                <SelectItem value="inherit">{resolve(SUSPENSION_MODES.inherit)}</SelectItem>
              )}
              <SelectItem value="off">{resolve(SUSPENSION_MODES.off)}</SelectItem>
              <SelectItem value="custom">{resolve(SUSPENSION_MODES.custom)}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {mode === "custom" && (
        <>
          <SettingsRow
            title={gt("Suspend after", { $context: "worktree suspension delay setting" })}
            description={gt(
              "Suspend after [1 – 3650] days since settlement (or archive if never settled), workspace use or restore, whichever is later. Status updates do not restart the count.",
            )}
            serverScoped
            settingKeys={["worktreeSuspension"]}
            control={
              <div className="flex w-36 items-center gap-2">
                <Input
                  aria-label={gt("Suspension delay in days")}
                  type="number"
                  min={MIN_WORKTREE_SUSPENSION_AFTER_DAYS}
                  max={MAX_WORKTREE_SUSPENSION_AFTER_DAYS}
                  step={1}
                  value={days}
                  disabled={disabled}
                  placeholder={gt("Choose days", { $context: "enter a worktree suspension delay" })}
                  onChange={(event) => setDays(event.currentTarget.value)}
                />
                <span className="text-xs text-muted-foreground">
                  <T>days</T>
                </span>
              </div>
            }
            status={
              days !== "" && !validDays ? gt("Choose a whole number from 1 to 3650.") : undefined
            }
          />
          {SCOPE_ROWS.map(({ key, title, description }) => {
            const label = resolve(title);
            return (
              <SettingsRow
                key={key}
                title={label}
                description={resolve(description)}
                serverScoped
                settingKeys={["worktreeSuspension"]}
                control={
                  <Checkbox
                    aria-label={label}
                    checked={scopes[key]}
                    disabled={disabled}
                    onCheckedChange={(checked) => setScopes({ ...scopes, [key]: checked })}
                  />
                }
              />
            );
          })}
          <SettingsRow
            title={gt("Apply suspension policy")}
            description={gt(
              "All thread types start disabled. Nothing is suspended until you save a delay and at least one thread type.",
            )}
            serverScoped
            settingKeys={["worktreeSuspension"]}
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || !validDays || !hasScope || unchanged}
                onClick={() => {
                  if (!disabled && validDays && hasScope) {
                    onSave({ mode: "custom", afterDays, scopes });
                  }
                }}
              >
                <T>Save suspension policy</T>
              </Button>
            }
          />
        </>
      )}
      {savedWorkspaces}
    </SuspensionGuidanceContext>
  );
}

function WorktreeSuspensionSettings({ savedWorkspaces }: { readonly savedWorkspaces?: ReactNode }) {
  const gt = useGT();
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreeSuspension"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const { scope, targets, target, environments, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const mode = projectScope ? projectPolicyMode(target) : settings.worktreeSuspension.mode;
  const mixedModes = projectScope && targets.some((entry) => projectPolicyMode(entry) !== mode);
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreeSuspension === true,
    );
  const vetoed = targets.some(
    (entry) =>
      entry.sources.worktreeCleanup === "project" && entry.settings.worktreeCleanup?.mode === "off",
  );
  const status =
    [
      !supported
        ? gt("Update every selected connected environment to configure worktree suspension.")
        : undefined,
      vetoed
        ? gt(
            "An explicit project cleanup Off override protects a selected project, so its worktrees will not suspend automatically.",
          )
        : undefined,
      environments.length > connectedEnvironments.length
        ? gt("Offline environments will not get this setting.")
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const formKey = JSON.stringify({
    targets: targets.map((entry) => [entry.environmentId, entry.projectId]),
    mode,
    mixed: mixed || mixedModes,
    policy: settings.worktreeSuspension,
  });

  return (
    <SuspensionPolicyForm
      key={formKey}
      initialMode={mixedModes || (!projectScope && mixed) ? null : mode}
      policy={settings.worktreeSuspension}
      mixed={mixed || mixedModes}
      projectScope={projectScope}
      disabled={!supported || !canWrite}
      status={status}
      savedWorkspaces={savedWorkspaces}
      onSave={(worktreeSuspension) => {
        if (supported && canWrite) updateSettings({ worktreeSuspension });
      }}
      onInherit={() => {
        if (supported && canWrite) clearSettings(["worktreeSuspension"]);
      }}
    />
  );
}

export function SavedWorkspacesLaunch({
  onOpen,
  disabled = false,
  description,
}: {
  readonly onOpen: () => void;
  readonly disabled?: boolean;
  readonly description?: ReactNode;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const showSuspensionGuidance = useContext(SuspensionGuidanceContext);
  return (
    <SettingsRow
      {...searchableSetting("storage-saved-workspaces")}
      description={
        <>
          {showSuspensionGuidance && (
            <span className="mb-2 block">
              {gt(
                "Choose {keepWorkspace} in a thread’s menu to protect its checkout from automatic suspension and cleanup. Worktrees currently in use are also left alone; this is detected automatically.",
                { keepWorkspace: "Keep workspace" },
              )}
            </span>
          )}
          {description === undefined
            ? gt(
                "Saved workspaces remain until you explicitly discard them. Restore or discard a saved copy here.",
              )
            : description}
        </>
      }
      control={
        <Button variant="outline" size="sm" disabled={disabled} onClick={onOpen}>
          <T>Manage saved workspaces</T>
        </Button>
      }
    >
      <p className="pt-2 pb-3 text-xs leading-relaxed text-muted-foreground">
        <em>
          {gt(
            "Saved workspaces are local recovery, not an off-machine backup. A saved scratch workspace needs only this environment’s saved data. A saved {git} worktree also needs the repository’s {git} data.",
            { git: "Git" },
          )}
        </em>
      </p>
    </SettingsRow>
  );
}

export function LastCodeStorageSettings({
  savedWorkspaces,
}: {
  readonly savedWorkspaces?: ReactNode;
}) {
  const gt = useGT();
  return (
    <SettingsSection id="storage-suspension" title={gt("Suspend inactive worktrees")}>
      <WorktreeSuspensionSettings savedWorkspaces={savedWorkspaces} />
    </SettingsSection>
  );
}
