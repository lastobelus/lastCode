/**
 * How a composer submission is delivered when the thread already has a turn in
 * flight. Shared by web (where the alternate is Mod+Enter) and mobile (where it
 * is a long-press on the send button), so both clients agree on what the user's
 * configured follow-up behavior means.
 */
export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** Recovery queues follow-ups while preserving an explicit restart request. */
export function applyComposerQueueConstraint(mode: ComposerDispatchMode, forceQueue: boolean) {
  return forceQueue && (mode === "auto" || mode === "steer") ? "queue" : mode;
}

/** The alternate switches between queue and steer relative to the configured action. */
export function resolveComposerDispatchMode(input: {
  /** A turn is in flight, so the follow-up has to queue behind it or steer it. */
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** The active recovery incident prevents delivery to the old provider turn. */
  readonly forceQueue?: boolean;
}): ComposerDispatchMode {
  if (input.forceQueue) {
    return input.running && input.activeTurnDefault === "restart" && !input.alternateModifier
      ? "restart"
      : "queue";
  }
  if (!input.running) return "auto";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

/** What the alternate would do, for labelling the affordance that triggers it. */
export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
  forceQueue = false,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    forceQueue,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}
