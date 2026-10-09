import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText, AppTextInput } from "../../../components/AppText";
import { parseMobileRetentionDays } from "../settings-worktree-dependencies";

export function RetentionDaysField(props: {
  readonly value: number | null;
  readonly disabled: boolean;
  readonly onValueChange: (value: number) => void;
}) {
  const [savedValue, setSavedValue] = useState(props.value);
  const [draft, setDraft] = useState<string | null>(null);
  // A settings refresh unrelated to this value must not discard an unfinished edit.
  if (savedValue !== props.value) {
    setSavedValue(props.value);
    setDraft(null);
  }
  const commit = (text: string | null) => {
    if (props.disabled || text === null) return;
    const days = parseMobileRetentionDays(text);
    if (days === null || days === props.value) {
      setDraft(null);
      return;
    }
    setDraft(String(days));
    props.onValueChange(days);
  };
  return (
    <View className="shrink-0 flex-row items-center gap-2">
      <AppTextInput
        className="min-h-11 w-20 rounded-xl px-3 py-2 text-center text-base"
        keyboardType="number-pad"
        returnKeyType="done"
        value={draft ?? (props.value === null ? "" : String(props.value))}
        placeholder={props.value === null ? "Mixed" : undefined}
        onChangeText={setDraft}
        onSubmitEditing={({ nativeEvent }) => commit(nativeEvent.text)}
        accessibilityLabel="Inactive days before worktree dependency cleanup"
        accessibilityHint="Enter 1 to 3650 days, then tap Save."
        editable={!props.disabled}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save dependency retention days"
        disabled={props.disabled || draft === null}
        onPress={() => commit(draft)}
        className="min-h-11 justify-center px-2 py-2 active:opacity-70"
      >
        <AppText
          className={
            props.disabled || draft === null
              ? "text-sm font-t3-medium text-foreground-muted"
              : "text-sm font-t3-medium text-primary-text"
          }
        >
          Save
        </AppText>
      </Pressable>
    </View>
  );
}
