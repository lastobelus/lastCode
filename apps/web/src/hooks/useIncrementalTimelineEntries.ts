import { useLocale, useMessages } from "gt-react";
import { useState } from "react";
import { shallow } from "zustand/vanilla/shallow";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
} from "../session-logic";

function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  // Asset hooks can return fresh but equivalent collections on a render retry.
  // Reference-only checks would schedule another retry indefinitely.
  return (
    shallow(left.visibleTurnItems, right.visibleTurnItems) &&
    shallow(left.optimisticMessages, right.optimisticMessages) &&
    shallow(left.anchoredMessages, right.anchoredMessages) &&
    shallow(left.attachmentUrlById, right.attachmentUrlById) &&
    shallow(left.attempts, right.attempts) &&
    shallow(left.nodes, right.nodes) &&
    shallow(left.plans, right.plans)
  );
}

export function useIncrementalTimelineEntries(
  threadKey: string | null,
  timelineInput: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  // Keyed on the locale: without a GTProvider, useMessages() returns a new function every render.
  const locale = useLocale();
  const resolve = useMessages();
  const input = { ...timelineInput, resolve: timelineInput.resolve ?? resolve };
  const [state, setState] = useState(() => ({
    threadKey,
    locale,
    projection: deriveTimelineEntriesFromVisibleTurnItemsWithState(input),
  }));
  const reusable = state.threadKey === threadKey && state.locale === locale;
  if (reusable && sameInput(state.projection.input, input)) {
    return state.projection.entries;
  }
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    input,
    reusable ? state.projection : null,
  );
  setState({ threadKey, locale, projection });
  return projection.entries;
}
