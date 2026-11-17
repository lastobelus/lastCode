import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { detectComposerTrigger } from "~/composer-logic";
import {
  expandedMarkdownToFlat,
  flatToMarkdown,
  flatToPm,
  pmToFlat,
  serializeEditorDoc,
  type RichDocMap,
} from "~/composer-rich-text-doc";
import {
  applyComposerSourceEdit,
  isComposerCaretInFence,
} from "~/lastcodeComposerLivePreviewTiptap";
import "./lastcode-composer-source.css";

/** Resolve source and document positions through the actual atoms, including literal fence text. */
export function resolveComposerSourcePosition(
  map: RichDocMap,
  position: { source: number } | { document: number },
) {
  const flat =
    "source" in position
      ? expandedMarkdownToFlat(map, position.source)
      : pmToFlat(map, position.document);
  return { flat, source: flatToMarkdown(map, flat), document: flatToPm(map, flat) };
}

/** Atom edges suppress suggestions; only possible triggers need the fence check. */
export function suppressComposerSourceTrigger(
  state: EditorState,
  map: RichDocMap,
  literalText: boolean,
) {
  if (literalText) return true;
  const position = resolveComposerSourcePosition(map, { document: state.selection.from });
  return (
    map.runs.some(
      (run) =>
        run.kind === "token" &&
        (position.flat === run.flatStart || position.flat === run.flatStart + run.docLen),
    ) ||
    (detectComposerTrigger(map.value, position.source) !== null && isComposerCaretInFence(state))
  );
}

/** A fence takes clipboard source verbatim, preserving literal token text. */
export function handleComposerSourcePaste(view: EditorView, text: string): boolean {
  if (!isComposerCaretInFence(view.state)) return false;
  const map = serializeEditorDoc(view.state.doc);
  const from = resolveComposerSourcePosition(map, { document: view.state.selection.from }).source;
  const to = resolveComposerSourcePosition(map, { document: view.state.selection.to }).source;
  return applyComposerSourceEdit(
    view,
    {
      value: map.value.slice(0, from) + text + map.value.slice(to),
      selection: { from: from + text.length, to: from + text.length },
    },
    { from, to },
  );
}
