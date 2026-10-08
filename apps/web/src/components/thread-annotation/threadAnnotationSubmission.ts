import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { parseThreadAnnotationSlashCommand } from "../../composer-logic";

export function parseThreadAnnotationSubmission(
  text: string,
  draft: ComposerThreadDraftState | null,
) {
  if (draft && composerDraftHasUserContent({ ...draft, prompt: "" })) return null;
  return parseThreadAnnotationSlashCommand(text);
}

/** A completed metadata save consumes only the immutable draft it submitted. */
export async function saveThreadAnnotationSubmission(input: {
  target: ComposerThreadTarget;
  draft: ComposerThreadDraftState | null;
  save: () => Promise<boolean>;
  onDraftConsumed: () => void;
}): Promise<boolean> {
  const saved = await input.save();
  if (!saved) return false;
  const store = useComposerDraftStore.getState();
  if (input.draft !== null && store.getComposerDraft(input.target) === input.draft) {
    store.clearComposerContent(input.target);
    input.onDraftConsumed();
  }
  return true;
}
