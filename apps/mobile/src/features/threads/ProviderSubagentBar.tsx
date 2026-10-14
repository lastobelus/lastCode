import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { presentSubagentPromotion } from "@t3tools/client-runtime/state/subagent-promotion";
import type { OrchestrationV2SubagentPromotion } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Platform, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { RequestActionButton } from "./RequestActionButton";
import { useVisibleSecondClock } from "./use-visible-second-clock";

/**
 * Replaces the composer on a provider-native subagent thread. The provider
 * runs that conversation, so there is nothing to send; the bar says which
 * model is working, for how long, and leads back to the parent.
 */
export function ProviderSubagentBar(props: {
  /** Driver and catalog icon of the provider running the subagent. */
  readonly provider: { readonly driver: string; readonly iconUrl?: string | undefined } | null;
  readonly modelLabel: string;
  /** Reasoning effort as the composer names it, when the subagent has one. */
  readonly effortLabel: string | null;
  /** Null until the subagent's root turn arrives. */
  readonly status: ProviderSubagentStatus | null;
  readonly onOpenParent: (() => void) | null;
  readonly promotion: OrchestrationV2SubagentPromotion | null;
  readonly promotionAvailable: boolean;
  readonly onPromote: (() => Promise<void>) | null;
  readonly onCancelPromotion: (() => Promise<void>) | null;
  readonly onOpenPromoted: (() => void) | null;
}) {
  const [pending, setPending] = useState(false);
  const [localError, setActionError] = useState<{ key: string; message: string } | null>(null);
  const promotionKey = `${props.promotion?.requestId ?? "none"}:${props.promotion?.status ?? "none"}`;
  const actionError = localError?.key === promotionKey ? localError.message : null;
  const pendingRef = useRef(false);
  const promotion = presentSubagentPromotion(props.promotion, pending);
  const act = async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError({
        key: promotionKey,
        message: error instanceof Error ? error.message : "Could not change subagent promotion.",
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const previousPromotionKey = useRef(promotionKey);
  useEffect(() => {
    if (previousPromotionKey.current === promotionKey) return;
    previousPromotionKey.current = promotionKey;
    if (Platform.OS !== "ios") return;
    const durable = presentSubagentPromotion(props.promotion, false);
    AccessibilityInfo.announceForAccessibility(
      `${durable.label}${durable.waiting ? ", waiting for subagent to complete" : ""}${durable.error ? `. ${durable.error}` : ""}`,
    );
  }, [promotionKey, props.promotion]);
  const live = props.status !== null && isOrchestrationV2WorkActive(props.status.status);
  const nowMs = useVisibleSecondClock(live);
  const statusLabel = formatProviderSubagentStatus(props.status, nowMs);
  const announcement = formatProviderSubagentStatus(
    props.status === null ? null : { ...props.status, startedAt: null },
    0,
  );
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;

  return (
    <View className="gap-2 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      <View className="flex-row items-center gap-3">
        {/* Only the text is one element, so "Open parent" stays reachable. */}
        <View
          accessible
          accessibilityLabel={`${modelDescription} subagent, ${announcement}. This subagent cannot take messages.`}
          className="min-w-0 flex-1 gap-0.5"
        >
          <View className="min-w-0 flex-row items-center gap-1.5">
            {props.provider ? (
              <ProviderIcon
                iconUrl={props.provider.iconUrl}
                provider={props.provider.driver}
                size={16}
              />
            ) : null}
            <Text numberOfLines={1} className="min-w-0 shrink font-t3-bold text-sm text-foreground">
              {props.modelLabel}
            </Text>
            {props.effortLabel === null ? null : (
              <Text
                numberOfLines={1}
                className="shrink-0 font-sans text-sm text-foreground-secondary"
              >
                {props.effortLabel}
              </Text>
            )}
          </View>
          <Text
            numberOfLines={1}
            className="font-sans text-xs text-foreground-secondary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {statusLabel}
            {props.promotionAvailable || props.promotion ? "" : " · Runs on its own"}
          </Text>
        </View>
        {props.onOpenParent ? (
          <RequestActionButton label="Open parent" tone="secondary" onPress={props.onOpenParent} />
        ) : null}
      </View>
      {props.promotionAvailable || props.promotion ? (
        <View className="gap-1.5">
          <View className="flex-row flex-wrap items-center gap-2">
            {promotion.busy ? <ActivityIndicator size="small" accessible={false} /> : null}
            <View className="min-w-0 shrink">
              <RequestActionButton
                label={promotion.label}
                accessibilityLabel={
                  props.promotion?.status === "failed"
                    ? "Retry promotion to interactive thread"
                    : promotion.label
                }
                accessibilityHint={
                  props.promotion?.status === "failed" ? (promotion.error ?? undefined) : undefined
                }
                tone="secondary"
                disabled={
                  promotion.disabled ||
                  (props.promotion?.status === "promoted"
                    ? !props.onOpenPromoted
                    : !props.onPromote)
                }
                onPress={() => {
                  if (props.promotion?.status === "promoted") props.onOpenPromoted?.();
                  else if (props.onPromote) void act(props.onPromote);
                }}
              />
            </View>
            {promotion.waiting ? (
              <RequestActionButton
                label="Cancel"
                tone="secondary"
                disabled={!promotion.canCancel || !props.onCancelPromotion}
                onPress={() => {
                  if (promotion.canCancel && props.onCancelPromotion)
                    void act(props.onCancelPromotion);
                }}
              />
            ) : null}
          </View>
          {promotion.waiting ? (
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-secondary">
              waiting for subagent to complete
            </Text>
          ) : null}
          {promotion.error || actionError ? (
            <Text accessibilityRole="alert" className="text-xs text-danger">
              {actionError ?? promotion.error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
