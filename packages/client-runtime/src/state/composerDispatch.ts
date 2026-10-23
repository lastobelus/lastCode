export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** Recovery queues follow-ups while preserving an explicit restart request. */
export function applyComposerQueueConstraint(mode: ComposerDispatchMode, forceQueue: boolean) {
  return forceQueue && (mode === "auto" || mode === "steer") ? "queue" : mode;
}

/** The alternate switches between queue and steer relative to the configured action. */
export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
  /** The active recovery incident prevents delivery to the old provider turn. */
  readonly forceQueue?: boolean;
}): ComposerDispatchMode {
  if (input.forceQueue) {
    return input.running && input.activeTurnDefault === "restart" && !input.alternateModifier
      ? "restart"
      : "queue";
  }
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

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
