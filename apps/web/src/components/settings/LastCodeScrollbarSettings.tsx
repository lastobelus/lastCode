import { useGT } from "gt-react";
import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { useSearchableSetting } from "./settingsSearch";
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
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("larger-scrollbars")}
        description={gt(
          "Make scrollbar thumbs easier to grab. Margin keeps the thumb clear of pane resize handles.",
        )}
        status={gt(
          "Exact native scrollbar width and margin require {lastCode} desktop or a {chromium}-based browser. {firefox} uses its larger system scrollbar; styled app scroll areas still follow both sliders.",
          { lastCode: "LastCode", chromium: "Chromium", firefox: "Firefox" },
        )}
        control={
          <Switch
            checked={clientSettings.largerScrollbarsEnabled}
            onCheckedChange={(checked) =>
              updateClientSettings({ largerScrollbarsEnabled: Boolean(checked) })
            }
            aria-label={gt("Larger scrollbars")}
          />
        }
      />
      {clientSettings.largerScrollbarsEnabled ? (
        <>
          <SettingsRow
            title={gt("Scrollbar width")}
            description={gt("Set the visible scrollbar thumb width in one-pixel increments.")}
            resetAction={
              clientSettings.scrollbarWidth !== DEFAULT_SCROLLBAR_WIDTH ? (
                <SettingResetButton
                  ariaLabel={gt("Reset scrollbar width to default")}
                  onClick={() => updateClientSettings({ scrollbarWidth: DEFAULT_SCROLLBAR_WIDTH })}
                />
              ) : null
            }
            control={
              <SettingsSlider
                id="scrollbar-width"
                label={gt("Scrollbar width")}
                min={MIN_SCROLLBAR_WIDTH}
                max={MAX_SCROLLBAR_WIDTH}
                value={clientSettings.scrollbarWidth}
                onChange={(scrollbarWidth) => updateClientSettings({ scrollbarWidth })}
              />
            }
          />
          <SettingsRow
            title={gt("Scrollbar margin")}
            description={gt("Set the clear space between a scrollbar thumb and the pane edge.")}
            resetAction={
              clientSettings.scrollbarMargin !== DEFAULT_SCROLLBAR_MARGIN ? (
                <SettingResetButton
                  ariaLabel={gt("Reset scrollbar margin to default")}
                  onClick={() =>
                    updateClientSettings({ scrollbarMargin: DEFAULT_SCROLLBAR_MARGIN })
                  }
                />
              ) : null
            }
            control={
              <SettingsSlider
                id="scrollbar-margin"
                label={gt("Scrollbar margin")}
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
