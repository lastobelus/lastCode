import { usePrimarySettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  DEFAULT_SCROLLBAR_MARGIN,
  DEFAULT_SCROLLBAR_WIDTH,
  MAX_SCROLLBAR_MARGIN,
  MAX_SCROLLBAR_WIDTH,
  MIN_SCROLLBAR_MARGIN,
  MIN_SCROLLBAR_WIDTH,
} from "@t3tools/contracts/settings";
import { Switch } from "../ui/switch";
import { LastCodeSettingsSlider as SettingsSlider } from "./LastCodeSettingsSlider";

export function LastCodeScrollbarSettings() {
  const clientSettings = usePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("larger-scrollbars")}
        description="Make scrollbar thumbs easier to grab. Margin keeps the thumb clear of pane resize handles."
        status="Exact native scrollbar width and margin require LastCode desktop or a Chromium-based browser. Firefox uses its larger system scrollbar; styled app scroll areas still follow both sliders."
        control={
          <Switch
            checked={clientSettings.largerScrollbarsEnabled}
            onCheckedChange={(checked) =>
              updateClientSettings({ largerScrollbarsEnabled: Boolean(checked) })
            }
            aria-label="Larger scrollbars"
          />
        }
      />
      {clientSettings.largerScrollbarsEnabled ? (
        <>
          <SettingsRow
            title="Scrollbar width"
            description="Set the visible scrollbar thumb width in one-pixel increments."
            resetAction={
              clientSettings.scrollbarWidth !== DEFAULT_SCROLLBAR_WIDTH ? (
                <SettingResetButton
                  label="scrollbar width"
                  onClick={() => updateClientSettings({ scrollbarWidth: DEFAULT_SCROLLBAR_WIDTH })}
                />
              ) : null
            }
            control={
              <SettingsSlider
                id="scrollbar-width"
                label="Scrollbar width"
                min={MIN_SCROLLBAR_WIDTH}
                max={MAX_SCROLLBAR_WIDTH}
                value={clientSettings.scrollbarWidth}
                onChange={(scrollbarWidth) => updateClientSettings({ scrollbarWidth })}
              />
            }
          />
          <SettingsRow
            title="Scrollbar margin"
            description="Set the clear space between a scrollbar thumb and the pane edge."
            resetAction={
              clientSettings.scrollbarMargin !== DEFAULT_SCROLLBAR_MARGIN ? (
                <SettingResetButton
                  label="scrollbar margin"
                  onClick={() =>
                    updateClientSettings({ scrollbarMargin: DEFAULT_SCROLLBAR_MARGIN })
                  }
                />
              ) : null
            }
            control={
              <SettingsSlider
                id="scrollbar-margin"
                label="Scrollbar margin"
                min={MIN_SCROLLBAR_MARGIN}
                max={MAX_SCROLLBAR_MARGIN}
                value={clientSettings.scrollbarMargin}
                onChange={(scrollbarMargin) => updateClientSettings({ scrollbarMargin })}
              />
            }
          />
        </>
      ) : null}
    </>
  );
}
