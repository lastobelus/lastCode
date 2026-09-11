import { handoffDestination, handoffTitle, type HandoffEntry } from "./handoffsStore";

export type HandoffMenuDescriptor = {
  readonly entry: HandoffEntry;
  readonly label: string;
};

export function describeHandoff(entry: HandoffEntry): HandoffMenuDescriptor {
  const title = entry.markdownLabel?.trim() || entry.title?.trim() || handoffTitle(entry);
  return { entry, label: `${title} — ${handoffDestination(entry)}` };
}
