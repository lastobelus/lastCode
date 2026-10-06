import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Mark } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";

/**
 * Follow the text on the right when moving the caret, or type plain at a line end.
 * Keep inclusive marks during edits so explicit formatting shortcuts continue typing.
 */
export function createComposerTypingMarksPlugin() {
  return new Plugin({
    appendTransaction(transactions, _oldState, state) {
      if (
        !state.selection.empty ||
        state.storedMarks !== null ||
        !transactions.some(
          (transaction) =>
            (transaction.selectionSet && !transaction.docChanged) ||
            isHistoryTransaction(transaction) ||
            transaction.getMeta("uiEvent") === "paste" ||
            transaction.getMeta("uiEvent") === "drop",
        )
      ) {
        return null;
      }
      const marks = state.selection.$from.nodeAfter?.marks ?? [];
      if (Mark.sameSet(marks, state.selection.$from.marks())) return null;
      return state.tr.setStoredMarks(marks);
    },
  });
}

export const ComposerTypingMarksExtension = Extension.create({
  name: "composer-typing-marks",
  addProseMirrorPlugins() {
    return [createComposerTypingMarksPlugin()];
  },
});
