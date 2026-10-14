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
  const [availableWidth, setAvailableWidth] = useState(0);
  const [measurement, setMeasurement] = useState<{ key: string; clipped: boolean } | null>(null);
  const measureShortPreview = !props.preview.canExpand && props.attachmentCount === 0;
  const measurementKey = `${availableWidth}:${props.preview.previewText}`;
  const clipped =
    measureShortPreview && (measurement?.key !== measurementKey || measurement.clipped);
  const canExpand = props.preview.canExpand || props.attachmentCount > 0 || clipped || expanded;
  const showOriginal = originalExpanded || !props.preview.isSummary;
  const attachmentLabel =
    props.attachmentCount > 0
      ? `${props.attachmentCount} ${props.attachmentCount === 1 ? "attachment" : "attachments"}`
      : "";
  const previewLabel = props.preview.previewText || attachmentLabel || "Incoming message";
  const previewLine = (
    <>
      {props.preview.pending ? (
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
      ) : null}
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {previewLabel}
      </Text>
      {props.attachmentCount > 0 ? (
        <SymbolView name="doc" size={13} tintColorClassName="accent-icon-muted" />
      ) : null}
      {canExpand ? (
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={11}
          tintColorClassName="accent-icon-muted"
        />
      ) : null}
    </>
  );

  return (
    <View className="min-w-0 gap-2">
      <View
        className="relative"
        onLayout={
          measureShortPreview
            ? (event) => setAvailableWidth(event.nativeEvent.layout.width)
            : undefined
        }
      >
        {canExpand ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.preview.pending ? "Summarizing. " : ""}${previewLabel}${props.preview.previewText && attachmentLabel ? `. ${attachmentLabel}` : ""}`}
            accessibilityHint={
              expanded
                ? "Collapse message."
                : `Expand to read ${props.preview.isSummary ? "the full summary or original message" : "the original message"}.`
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
            {previewLine}
          </Pressable>
        ) : (
          <View className="min-w-0 flex-row items-center gap-2">{previewLine}</View>
        )}
        {measureShortPreview && availableWidth > 0 ? (
          <View
            key={measurementKey}
            className="absolute inset-x-0 top-0 opacity-0"
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {/* Measure at the full resting width so adding a chevron cannot keep it clipped. */}
            <Text
              className="text-sm text-foreground"
              onTextLayout={(event) => {
                const nextClipped = event.nativeEvent.lines.length > 1;
                setMeasurement((current) =>
                  current?.key === measurementKey && current.clipped === nextClipped
                    ? current
                    : { key: measurementKey, clipped: nextClipped },
                );
              }}
            >
              {props.preview.previewText}
            </Text>
          </View>
        ) : null}
      </View>
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
