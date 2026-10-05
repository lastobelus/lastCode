import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { presentSubagentPromotion } from "@t3tools/client-runtime/state/subagent-promotion";
import type { OrchestrationV2SubagentPromotion } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { ArrowUpLeftIcon, ArrowUpRightIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * Stands in for the composer on a provider-native subagent thread. The
 * provider runs that conversation, so there is nothing to send; the bar says
 * which model is working, for how long, and leads back to the parent.
 */
export function ProviderSubagentBar(props: {
  /** The provider running the subagent; no icon while its catalog loads. */
  readonly provider: ProviderInstanceEntry | null;
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
  const containerRef = useRef<HTMLDivElement>(null);
  const promotionButtonRef = useRef<HTMLButtonElement>(null);
  const focusedActionRef = useRef<"promote" | "cancel" | null>(null);
  useLayoutEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target))
        focusedActionRef.current = null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  useLayoutEffect(() => {
    if (
      !promotion.waiting &&
      focusedActionRef.current === "cancel" &&
      document.hasFocus() &&
      document.activeElement === document.body
    ) {
      promotionButtonRef.current?.focus();
    }
  }, [promotion.waiting]);
  const statusRef = useRef<HTMLSpanElement>(null);
  const { status } = props;
  const live = status !== null && isOrchestrationV2WorkActive(status.status);
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;
  // Announced once per transition; the ticking label below is not.
  const announcement = formatProviderSubagentStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
  );

  // The label is written from an effect, and live bars tick through DOM
  // writes, so a running timer never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatProviderSubagentStatus(status, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, status]);

  return (
    <div
      ref={containerRef}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !containerRef.current?.contains(event.relatedTarget)
        )
          focusedActionRef.current = null;
      }}
      className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-3xl py-2 ps-5 pe-2 text-sm"
    >
      <span className="flex min-w-0 items-center gap-2">
        {props.provider ? (
          <ProviderInstanceIcon
            driverKind={props.provider.driverKind}
            displayName={props.provider.displayName}
            accentColor={props.provider.accentColor}
            acpRegistryAgentId={props.provider.acpRegistryAgentId}
            acpRegistryIconUrl={props.provider.acpRegistryIconUrl}
            className="size-4 shrink-0"
            iconClassName="size-4"
          />
        ) : null}
        <span className="min-w-0 truncate font-medium text-foreground">{props.modelLabel}</span>
        {props.effortLabel === null ? null : (
          <span className="shrink-0 text-muted-foreground">{props.effortLabel}</span>
        )}
      </span>
      <span
        ref={statusRef}
        aria-hidden
        className="min-w-0 truncate text-muted-foreground tabular-nums"
      />
      <span role="status" className="sr-only">
        {`${modelDescription} subagent: ${announcement}`}
      </span>
      <div className="ms-auto flex min-w-0 max-w-full flex-wrap items-center gap-2">
        {props.promotionAvailable || props.promotion ? (
          <div className="flex min-w-0 max-w-full flex-col gap-1">
            <div className="flex max-w-full flex-wrap items-center gap-2">
              <div className="grid min-w-0 max-w-full">
                <Button
                  ref={promotionButtonRef}
                  onFocus={() => {
                    focusedActionRef.current = "promote";
                  }}
                  size="sm-multiline"
                  variant="outline"
                  aria-label={
                    props.promotion?.status === "failed"
                      ? "Retry promotion to interactive thread"
                      : undefined
                  }
                  aria-busy={promotion.busy}
                  aria-disabled={
                    promotion.disabled ||
                    (props.promotion?.status === "promoted"
                      ? !props.onOpenPromoted
                      : !props.onPromote)
                  }
                  onClick={() => {
                    if (promotion.disabled) return;
                    if (props.promotion?.status === "promoted") props.onOpenPromoted?.();
                    else if (props.onPromote) void act(props.onPromote);
                  }}
                >
                  {promotion.busy ? (
                    <Spinner
                      size="sm"
                      tone="muted"
                      role="presentation"
                      aria-hidden
                      aria-label={undefined}
                    />
                  ) : null}
                  {promotion.label}
                  {props.promotion?.status === "promoted" ? <ArrowUpRightIcon /> : null}
                </Button>
              </div>
              {promotion.waiting ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onFocus={() => {
                    focusedActionRef.current = "cancel";
                  }}
                  aria-disabled={!promotion.canCancel || !props.onCancelPromotion}
                  onClick={() => {
                    if (promotion.canCancel && props.onCancelPromotion)
                      void act(props.onCancelPromotion);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
            {promotion.waiting ? (
              <span className="text-xs text-muted-foreground">
                waiting for subagent to complete
              </span>
            ) : null}
            {promotion.error || actionError ? (
              <span
                role="alert"
                className="min-w-0 text-xs text-destructive [overflow-wrap:anywhere]"
              >
                {actionError ?? promotion.error}
              </span>
            ) : null}
            <span role="status" className="sr-only">
              {promotion.busy || props.promotion?.status === "promoted" ? promotion.label : ""}
              {promotion.waiting ? ", waiting for subagent to complete" : ""}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">Runs on its own</span>
        )}
        {props.onOpenParent ? (
          <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
            <ArrowUpLeftIcon />
            Open parent
          </Button>
        ) : null}
      </div>
    </div>
  );
}
