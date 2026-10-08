import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import type { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

/** A touch disclosure keeps summaries compact without taking away the original message. */
export function IncomingMessageDisclosure(props: {
  readonly preview: ReturnType<typeof resolveIncomingMessagePreview>;
  readonly attachmentCount: number;
  readonly attachments: ReactNode;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [originalExpanded, setOriginalExpanded] = useState(false);
  const showOriginal = originalExpanded || !props.preview.isSummary;
  const attachmentHint =
    props.attachmentCount > 0
      ? ` Includes ${props.attachmentCount} ${props.attachmentCount === 1 ? "attachment" : "attachments"}.`
      : "";

  return (
    <View className="min-w-0 gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.preview.pending ? "Summarizing. " : ""}${props.preview.previewText}`}
        accessibilityHint={
          expanded
            ? "Collapse message."
            : `Expand to read ${props.preview.isSummary ? "the full summary or original message" : "the original message"}.${attachmentHint}`
        }
        accessibilityState={{ expanded }}
        className="min-w-0 flex-row items-center gap-2"
        hitSlop={8}
        onPress={() => {
          setExpanded(!expanded);
          // An original opened while its summary is pending stays open when the summary arrives.
          setOriginalExpanded(!expanded && !props.preview.isSummary);
        }}
      >
        {props.preview.pending ? (
          <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : null}
        <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
          {props.preview.previewText}
        </Text>
        {props.attachmentCount > 0 ? (
          <SymbolView name="paperclip" size={13} tintColorClassName="accent-icon-muted" />
        ) : null}
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={11}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {expanded ? (
        <>
          {props.preview.isSummary ? (
            <Text selectable className="text-sm leading-normal text-foreground">
              {props.preview.previewText}
            </Text>
          ) : null}
          {props.attachments}
          {props.preview.isSummary ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={showOriginal ? "Hide original message" : "Show original message"}
              accessibilityState={{ expanded: showOriginal }}
              className="self-start py-1"
              hitSlop={8}
              onPress={() => setOriginalExpanded(!originalExpanded)}
            >
              <Text className="font-t3-medium text-xs text-foreground-secondary">
                {showOriginal ? "Hide original" : "Show original"}
              </Text>
            </Pressable>
          ) : null}
          {showOriginal ? props.children : null}
        </>
      ) : null}
    </View>
  );
}
