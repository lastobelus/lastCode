import { usePrimarySettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow } from "./settingsLayout";
import { MAX_HANDOFFS_MENU_LIMIT, MIN_HANDOFFS_MENU_LIMIT } from "@t3tools/contracts/settings";

export function LastCodeHandoffSettings() {
  const clientSettings = usePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("handoffs-menu-limit")}
        description="Choose how many recently opened handoffs appear in thread menus."
        control={
          <input
            aria-label="Handoffs shown in menus"
            className="w-16 rounded-md border bg-background px-2 py-1 text-center"
            max={MAX_HANDOFFS_MENU_LIMIT}
            min={MIN_HANDOFFS_MENU_LIMIT}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (
                Number.isInteger(value) &&
                value >= MIN_HANDOFFS_MENU_LIMIT &&
                value <= MAX_HANDOFFS_MENU_LIMIT
              ) {
                void updateClientSettings({ handoffsMenuLimit: value });
              }
            }}
            type="number"
            value={clientSettings.handoffsMenuLimit}
          />
        }
      />
    </>
  );
}
