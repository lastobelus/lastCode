import {
  MAX_WORKTREE_SUSPENSION_AFTER_DAYS,
  MIN_WORKTREE_SUSPENSION_AFTER_DAYS,
  type WorktreeSuspensionPolicy,
  type WorktreeSuspensionScopes,
} from "@t3tools/contracts/settings";
import { createContext, useContext, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
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
const SCOPE_ROWS = [
  {
    key: "subagents",
    title: "Finished subagents",
    description:
      "Suspend work that was delegated to a subagent and is now finished. A worktree in use, or one with Keep workspace on, is not suspended.",
  },
  {
    key: "untouchedChildren",
    title: "Child threads you haven’t joined",
    description:
      "Threads an agent started that you haven’t taken part in. Reading one does not count as joining it. If LastCode can’t tell, the worktree stays.",
  },
  {
    key: "otherThreads",
    title: "Top-level threads and threads you’ve joined",
    description:
      "Includes threads you created, adopted or participated in, including former subagents. Leave this off so this policy never suspends their worktrees. Other cleanup rules you have turned on can still remove them.",
  },
] as const;

type PolicySelection = "inherit" | "off" | "custom" | null;

function projectPolicyMode(target: ScopedSettingsTarget | null): PolicySelection {
  return target?.sources.worktreeSuspension === "project"
    ? target.settings.worktreeSuspension.mode
    : "inherit";
}

function policySummary(policy: WorktreeSuspensionPolicy): string {
  if (policy.mode === "off") return "Automatic suspension is Off.";
  const scopeCount = Object.values(policy.scopes).filter(Boolean).length;
  return scopeCount === 0
    ? "No thread types are enabled for automatic suspension."
    : `Enabled for ${scopeCount} ${scopeCount === 1 ? "thread type" : "thread types"} after ${policy.afterDays} ${policy.afterDays === 1 ? "day" : "days"} settled and unused.`;
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
            ? "Choose how many days to wait and which kinds of threads to include, then save. Your other cleanup rules stay as they are."
            : mode === "inherit"
              ? mixed
                ? "Inherit each selected environment’s policy; their values differ."
                : `Inherit the environment’s policy. ${policySummary(policy)}`
              : "Save local work and put away eligible checkouts without archiving the conversation — LastCode saves each worktree’s work on this machine, removes the folder, and restores it when you continue."
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
            <SelectTrigger size="sm" aria-label="Suspend worktrees automatically">
              <SelectValue>
                {mode === null
                  ? "Mixed"
                  : mode === "inherit"
                    ? "Inherit"
                    : mode === "off"
                      ? "Off"
                      : "Custom"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {projectScope && <SelectItem value="inherit">Inherit</SelectItem>}
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {mode === "custom" && (
        <>
          <SettingsRow
            title="Suspend after"
            description="Suspend after [1 – 3650] days, counted from when the thread settled or its worktree was last used or restored, whichever is later. Status updates do not restart the count."
            serverScoped
            settingKeys={["worktreeSuspension"]}
            control={
              <div className="flex w-36 items-center gap-2">
                <Input
                  aria-label="Suspension delay in days"
                  type="number"
                  min={MIN_WORKTREE_SUSPENSION_AFTER_DAYS}
                  max={MAX_WORKTREE_SUSPENSION_AFTER_DAYS}
                  step={1}
                  value={days}
                  disabled={disabled}
                  placeholder="Choose days"
                  onChange={(event) => setDays(event.currentTarget.value)}
                />
                <span className="text-xs text-muted-foreground">days</span>
              </div>
            }
            status={days !== "" && !validDays ? "Choose a whole number from 1 to 3650." : undefined}
          />
          {SCOPE_ROWS.map(({ key, title, description }) => (
            <SettingsRow
              key={key}
              title={title}
              description={description}
              serverScoped
              settingKeys={["worktreeSuspension"]}
              control={
                <Checkbox
                  aria-label={title}
                  checked={scopes[key]}
                  disabled={disabled}
                  onCheckedChange={(checked) => setScopes({ ...scopes, [key]: checked })}
                />
              }
            />
          ))}
          <SettingsRow
            title="Apply suspension policy"
            description="All thread types start disabled. Nothing is suspended until you save a delay and at least one thread type."
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
                Save suspension policy
              </Button>
            }
          />
        </>
      )}
      {savedWorkspaces}
    </SuspensionGuidanceContext>
  );
}

export function WorktreeSuspensionSettings({
  savedWorkspaces,
}: {
  readonly savedWorkspaces?: ReactNode;
}) {
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
        ? "Update every selected connected environment to configure worktree suspension."
        : undefined,
      vetoed
        ? "An explicit project cleanup Off override protects a selected project, so its worktrees will not suspend automatically."
        : undefined,
      environments.length > connectedEnvironments.length
        ? "Offline environments will not get this setting."
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
  description = "Saved workspaces remain until you explicitly discard them. Restore or discard a saved copy here.",
}: {
  readonly onOpen: () => void;
  readonly disabled?: boolean;
  readonly description?: ReactNode;
}) {
  const showSuspensionGuidance = useContext(SuspensionGuidanceContext);
  return (
    <SettingsRow
      {...searchableSetting("storage-saved-workspaces")}
      description={
        <>
          {showSuspensionGuidance && (
            <span className="mb-2 block">
              Choose Keep workspace in a thread’s menu to protect its checkout from automatic
              suspension and cleanup. Worktrees currently in use are also left alone; this is
              detected automatically.
            </span>
          )}
          {description}
        </>
      }
      control={
        <Button variant="outline" size="sm" disabled={disabled} onClick={onOpen}>
          Manage saved workspaces
        </Button>
      }
    >
      <p className="pt-2 pb-3 text-xs leading-relaxed text-muted-foreground">
        <em>
          Saved workspaces are local recovery: they depend on this environment’s saved data and the
          repository’s Git data. They are not an off-machine backup.
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
  return (
    <SettingsSection id="storage-suspension" title="Suspend settled worktrees">
      <WorktreeSuspensionSettings savedWorkspaces={savedWorkspaces} />
    </SettingsSection>
  );
}
