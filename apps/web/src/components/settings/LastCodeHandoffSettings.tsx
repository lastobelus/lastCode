import { useGT } from "gt-react";
import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow } from "./settingsLayout";
import { MAX_HANDOFFS_MENU_LIMIT, MIN_HANDOFFS_MENU_LIMIT } from "@t3tools/contracts/settings";

export function LastCodeHandoffSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("handoffs-menu-limit")}
        description={gt("Choose how many recently opened handoffs appear in thread menus.")}
        control={
          <input
            aria-label={gt("Handoffs shown in menus")}
            className="w-16 rounded-md border bg-background px-2 py-1 text-center"
            max={MAX_HANDOFFS_MENU_LIMIT}
            min={MIN_HANDOFFS_MENU_LIMIT}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (!Number.isInteger(value)) return;
              if (value < MIN_HANDOFFS_MENU_LIMIT) return;
              if (value > MAX_HANDOFFS_MENU_LIMIT) return;
              void updateClientSettings({ handoffsMenuLimit: value });
            }}
            type="number"
            value={clientSettings.handoffsMenuLimit}
          />
        }
      />
    </>
  );
}
