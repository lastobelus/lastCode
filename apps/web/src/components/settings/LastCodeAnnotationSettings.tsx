import { useGT } from "gt-react";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow } from "./settingsLayout";
import { Switch } from "../ui/switch";

export function LastCodeAnnotationSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const expanded = useClientSettings((settings) => settings.expandThreadAnnotations);
  return (
    <SettingsRow
      {...searchableSetting("expand-thread-annotations")}
      description={gt(
        "Show annotations in full above the composer when added or edited. A collapsed annotation stays collapsed until you expand or edit it.",
      )}
      control={
        <Switch
          aria-label={gt("Expand thread annotations by default")}
          checked={expanded}
          onCheckedChange={(expandThreadAnnotations) =>
            updateClientSettings({ expandThreadAnnotations })
          }
        />
      }
    />
  );
}
