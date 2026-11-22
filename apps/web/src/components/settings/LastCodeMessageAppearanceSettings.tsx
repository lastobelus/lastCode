import { useGT } from "gt-react";
import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { useSearchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

export function LastCodeMessageAppearanceSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const clientSettings = usePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("incoming-message-style")}
        description={gt("Choose how agent and automation messages appear in the conversation.")}
        resetAction={
          clientSettings.incomingMessageStyle !== "neutral" ? (
            <SettingResetButton
              ariaLabel={gt("Reset incoming message style to default")}
              onClick={() => updateClientSettings({ incomingMessageStyle: "neutral" })}
            />
          ) : null
        }
        control={
          <Select
            value={clientSettings.incomingMessageStyle}
            onValueChange={(value) => {
              if (value === "neutral" || value === "outline") {
                updateClientSettings({ incomingMessageStyle: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={gt("Incoming message style")}>
              <SelectValue>
                {clientSettings.incomingMessageStyle === "neutral"
                  ? gt("Neutral fill")
                  : gt("Outline")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="neutral">{gt("Neutral fill")}</SelectItem>
              <SelectItem value="outline">{gt("Outline")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {clientSettings.incomingMessageStyle === "neutral" ? (
        <SettingsRow
          {...searchableSetting("incoming-message-fill-color")}
          description={gt(
            "Experiment with a fill color for agent and automation messages. Automatic follows your theme.",
          )}
          resetAction={
            clientSettings.incomingMessageFillColor !== null ? (
              <SettingResetButton
                ariaLabel={gt("Reset incoming message fill color to default")}
                onClick={() => updateClientSettings({ incomingMessageFillColor: null })}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {clientSettings.incomingMessageFillColor ?? gt("Automatic")}
              </span>
              <ProviderAccentColorPicker
                displayName={gt("incoming messages")}
                label={gt("Fill color")}
                value={clientSettings.incomingMessageFillColor ?? undefined}
                defaultOptionLabel={gt("Automatic")}
                layout="inline"
                onCommit={(value) =>
                  updateClientSettings({ incomingMessageFillColor: value || null })
                }
              />
            </div>
          }
        />
      ) : null}
    </>
  );
}
