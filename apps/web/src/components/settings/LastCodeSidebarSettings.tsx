import { msg, T, useGT } from "gt-react";
import { LastCodeStatusIconSettings } from "./LastCodeStatusIconSettings";
import { lastCodeStatusIcon } from "../../lastcodeStatusIcons";
import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { useSearchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { type CSSProperties } from "react";
import { ThreadId } from "@t3tools/contracts";
import {
  DEFAULT_LEGACY_SIDEBAR_SCALE,
  MIN_LEGACY_SIDEBAR_SCALE,
  MAX_LEGACY_SIDEBAR_SCALE,
  LEGACY_SIDEBAR_SCALE_REFERENCE,
} from "@t3tools/contracts/settings";
import { Switch } from "../ui/switch";
import { EnvironmentIcon } from "../../environmentIcons";
import { ThreadStatusLabel, ThreadWorktreeIndicator } from "../ThreadStatusIndicators";

const STATUS_INDICATOR_PREVIEW = {
  colorClass: "text-sky-600 dark:text-sky-300/80",
  dotClass: "bg-sky-500 dark:bg-sky-300/80",
  label: msg("Working"),
  pulse: false,
} as const;

const WORKTREE_INDICATOR_PREVIEW_THREAD = {
  id: ThreadId.make("settings-worktree-preview"),
  branch: "feature/example",
  worktreePath: "/example/worktrees/example",
};

function LastCodeSidebarScaleSetting() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  const legacySidebarScaleRatio =
    (clientSettings.legacySidebarScale - MIN_LEGACY_SIDEBAR_SCALE) /
    (MAX_LEGACY_SIDEBAR_SCALE - MIN_LEGACY_SIDEBAR_SCALE);
  const legacySidebarScaleSliderStyle = {
    "--settings-slider-progress": `${legacySidebarScaleRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - legacySidebarScaleRatio}rem`,
  } as CSSProperties;
  return (
    <>
      <SettingsRow
        {...searchableSetting("scale-legacy-sidebar")}
        description={gt(
          "Scale {lastCode} project and thread rows without changing the sidebar header, Search field, or Projects heading. The 75% marker matches the normalized version of the original compact-sidebar patch.",
          { lastCode: "LastCode" },
        )}
        resetAction={
          clientSettings.legacySidebarScale !== DEFAULT_LEGACY_SIDEBAR_SCALE ? (
            <SettingResetButton
              ariaLabel={gt("Reset LastCode sidebar scale to default")}
              onClick={() =>
                updateClientSettings({ legacySidebarScale: DEFAULT_LEGACY_SIDEBAR_SCALE })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-64">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="legacy-sidebar-scale"
            >
              {clientSettings.legacySidebarScale}%
            </output>
            <div className="relative min-w-0 flex-1 pb-3">
              <input
                aria-label={gt("Scale {lastCode} sidebar", { lastCode: "LastCode" })}
                className="settings-slider block w-full"
                id="legacy-sidebar-scale"
                max={MAX_LEGACY_SIDEBAR_SCALE}
                min={MIN_LEGACY_SIDEBAR_SCALE}
                onChange={(event) => {
                  const legacySidebarScale = Number(event.currentTarget.value);
                  if (!Number.isInteger(legacySidebarScale)) return;
                  if (legacySidebarScale < MIN_LEGACY_SIDEBAR_SCALE) return;
                  if (legacySidebarScale > MAX_LEGACY_SIDEBAR_SCALE) return;
                  updateClientSettings({ legacySidebarScale });
                }}
                step={1}
                style={legacySidebarScaleSliderStyle}
                type="range"
                value={clientSettings.legacySidebarScale}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-5 left-1/2 flex -translate-x-1/2 flex-col items-center text-3xs leading-none text-muted-foreground"
              >
                <span className="h-1.5 border-muted-foreground/60 border-l" />
                <span className="mt-0.5">{LEGACY_SIDEBAR_SCALE_REFERENCE}%</span>
              </span>
            </div>
          </div>
        }
      />
    </>
  );
}

function LastCodeSidebarGroupingSetting() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  const minimalLabel = gt("Minimal", { $context: "sidebar thread grouping style" });
  const typedGroupsLabel = gt("Typed groups", { $context: "sidebar thread grouping style" });
  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-grouping-style")}
        description={gt(
          "Choose how the {lastCode} sidebar distinguishes subagents from ordinary threads created by an agent. This changes presentation, not thread relationships.",
          { lastCode: "LastCode" },
        )}
        resetAction={
          clientSettings.legacySidebarThreadGroupingStyle !== "minimal" ? (
            <SettingResetButton
              ariaLabel={gt("Reset thread grouping style to default")}
              onClick={() => updateClientSettings({ legacySidebarThreadGroupingStyle: "minimal" })}
            />
          ) : null
        }
        control={
          <Select
            value={clientSettings.legacySidebarThreadGroupingStyle}
            onValueChange={(value) => {
              if (value === "minimal" || value === "typed-groups") {
                updateClientSettings({ legacySidebarThreadGroupingStyle: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={gt("Thread grouping style")}>
              <SelectValue>
                {clientSettings.legacySidebarThreadGroupingStyle === "minimal"
                  ? minimalLabel
                  : typedGroupsLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="minimal">{minimalLabel}</SelectItem>
              <SelectItem value="typed-groups">{typedGroupsLabel}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

function LastCodeSidebarPresentationSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const clientSettings = usePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("family-status-subheaders")}
        description={gt(
          "Show a separate subagent count and status row for more visibility. Turn this off for a compact status indicator and +N count on the parent thread.",
        )}
        control={
          <Switch
            checked={clientSettings.lastcodeSidebarFamilyStatusSubheaders}
            onCheckedChange={(checked) =>
              updateClientSettings({ lastcodeSidebarFamilyStatusSubheaders: Boolean(checked) })
            }
            aria-label={gt("Family status subheaders")}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("rounded-project-icons")}
        description={gt(
          "Round the corners of project favicon images. Leave this off to show each icon's original shape.",
        )}
        control={
          <Switch
            checked={clientSettings.roundedProjectIcons}
            onCheckedChange={(checked) =>
              updateClientSettings({ roundedProjectIcons: Boolean(checked) })
            }
            aria-label={gt("Rounded project icons")}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("compact-status-indicators")}
        description={gt("Show only the status icon, hiding labels like “Working” and “Completed.”")}
        status={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sidebar px-2 py-1 text-sm text-foreground">
            <ThreadStatusLabel
              compact={clientSettings.compactLegacySidebarStatuses}
              status={STATUS_INDICATOR_PREVIEW}
              icon={lastCodeStatusIcon("Working", clientSettings.lastcodeStatusIcons)}
            />
            <span>
              <T context="example thread title in a sidebar preview">Title</T>
            </span>
          </span>
        }
        control={
          <Switch
            checked={clientSettings.compactLegacySidebarStatuses}
            onCheckedChange={(checked) =>
              updateClientSettings({ compactLegacySidebarStatuses: Boolean(checked) })
            }
            aria-label={gt("Compact status indicators")}
          />
        }
      />
      <LastCodeStatusIconSettings />
      <SettingsRow
        {...searchableSetting("show-worktree-indicators")}
        description={gt(
          "Show the worktree icon beside threads that use a dedicated worktree in the {lastCode} sidebar.",
          { lastCode: "LastCode" },
        )}
        status={
          <span className="inline-flex items-center gap-1 rounded-full bg-sidebar px-2 py-1 text-3xs tabular-nums text-secondary-label">
            {clientSettings.showThreadWorktreeIndicators ? (
              <ThreadWorktreeIndicator thread={WORKTREE_INDICATOR_PREVIEW_THREAD} />
            ) : null}
            <EnvironmentIcon kind="server" context="legacy-row" className="size-3" />
            <span>{gt("{count}m ago", { count: 5 })}</span>
          </span>
        }
        control={
          <Switch
            checked={clientSettings.showThreadWorktreeIndicators}
            onCheckedChange={(checked) =>
              updateClientSettings({ showThreadWorktreeIndicators: Boolean(checked) })
            }
            aria-label={gt("Show worktree indicators ({lastCode} sidebar)", {
              lastCode: "LastCode",
            })}
          />
        }
      />
    </>
  );
}

export function LastCodeSidebarSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const clientSettings = usePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("lastcode-sidebar")}
        description={gt(
          "Use the {lastCode} project and thread tree instead of the v2 sidebar. While on, the tree button switches between {lastCode} and v2 without changing this setting.",
          { lastCode: "LastCode" },
        )}
        control={
          <Switch
            aria-label={gt("{lastCode} sidebar", { lastCode: "LastCode" })}
            checked={clientSettings.lastcodeSidebarEnabled}
            onCheckedChange={(checked) =>
              updateClientSettings({ lastcodeSidebarEnabled: Boolean(checked) })
            }
          />
        }
      />
      <LastCodeSidebarScaleSetting />
      <LastCodeSidebarGroupingSetting />
      <LastCodeSidebarPresentationSettings />
    </>
  );
}
