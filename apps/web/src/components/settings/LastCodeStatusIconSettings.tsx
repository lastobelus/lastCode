import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { configurableThreadStatuses } from "../Sidebar.logic";
import { ThreadStatusGlyph } from "../ThreadStatusGlyph";
import { lastCodeStatusIcon } from "../../lastcodeStatusIcons";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const ICON_OPTIONS = (
  ["triangle", "triangle-right", "square", "diamond", "circle"] as const
).flatMap((shape) =>
  (["open", "solid", "outline-fill"] as const).map((style) => ({
    value: `${shape}-${style}`,
    label: `${style === "open" ? "Open" : style === "outline-fill" ? "Outline + 50% fill" : "Solid"} ${shape === "triangle-right" ? "right-pointing triangle" : shape}`,
    icon: { shape, style },
  })),
);

export function LastCodeStatusIconSettings() {
  const { lastcodeStatusIcons } = usePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("status-icons")}
      description="Choose a shape for each agent status. Colors and meanings stay the same. New statuses start with a solid circle."
      resetAction={
        Object.keys(lastcodeStatusIcons).length > 0 ? (
          <SettingResetButton
            label="status icons"
            onClick={() => updateClientSettings({ lastcodeStatusIcons: {} })}
          />
        ) : null
      }
    >
      <div className="divide-y divide-border/40">
        {configurableThreadStatuses.map((status) => {
          const icon = lastCodeStatusIcon(status.label, lastcodeStatusIcons);
          const value = `${icon.shape}-${icon.style}`;
          return (
            <div key={status.label} className="flex items-center justify-between gap-4 py-2">
              <span className={`inline-flex items-center gap-2 text-xs ${status.colorClass}`}>
                <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                  <ThreadStatusGlyph icon={icon} dotClass={status.dotClass} />
                </span>
                {status.label}
              </span>
              <Select
                value={value}
                onValueChange={(nextValue) => {
                  const option = ICON_OPTIONS.find((entry) => entry.value === nextValue);
                  if (!option) return;
                  updateClientSettings((settings) => {
                    const next = { ...settings.lastcodeStatusIcons };
                    if (option.value === "circle-solid") delete next[status.label];
                    else next[status.label] = option.icon;
                    return { lastcodeStatusIcons: next };
                  });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-44"
                  aria-label={`${status.label} status icon`}
                >
                  <SelectValue>
                    {ICON_OPTIONS.find((option) => option.value === value)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {ICON_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                          <ThreadStatusGlyph icon={option.icon} dotClass={status.dotClass} />
                        </span>
                        {option.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          );
        })}
      </div>
    </SettingsRow>
  );
}
