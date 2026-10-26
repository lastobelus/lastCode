import { usePrimarySettings, updateClientSettings } from "../../hooks/useSettings";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

export function LastCodeMessageAppearanceSettings() {
  const clientSettings = usePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("incoming-message-style")}
        description="Choose how agent and automation messages appear in the conversation."
        resetAction={
          clientSettings.incomingMessageStyle !== "neutral" ? (
            <SettingResetButton
              label="incoming message style"
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
            <SelectTrigger size="sm" className="w-44" aria-label="Incoming message style">
              <SelectValue>
                {clientSettings.incomingMessageStyle === "neutral" ? "Neutral fill" : "Outline"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="neutral">Neutral fill</SelectItem>
              <SelectItem value="outline">Outline</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {clientSettings.incomingMessageStyle === "neutral" ? (
        <SettingsRow
          {...searchableSetting("incoming-message-fill-color")}
          description="Experiment with a fill color for agent and automation messages. Automatic follows your theme."
          resetAction={
            clientSettings.incomingMessageFillColor !== null ? (
              <SettingResetButton
                label="incoming message fill color"
                onClick={() => updateClientSettings({ incomingMessageFillColor: null })}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {clientSettings.incomingMessageFillColor ?? "Automatic"}
              </span>
              <ProviderAccentColorPicker
                displayName="incoming messages"
                label="Fill color"
                value={clientSettings.incomingMessageFillColor ?? undefined}
                defaultOptionLabel="Automatic"
                layout="inline"
                commitDelayMs={120}
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
