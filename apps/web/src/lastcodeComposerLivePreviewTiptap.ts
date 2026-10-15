import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  collectMarkdownSourceRanges,
  type MarkdownSourceRanges,
} from "@t3tools/shared/lastcodeMarkdownSourceRanges";

import {
  buildComposerLivePreview,
  MAX_COMPOSER_LIVE_PREVIEW_LENGTH,
} from "~/lastcodeComposerLivePreview";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Fragment, Slice } from "@tiptap/pm/model";
import { ComposerCodeBlockLanguagePicker } from "~/components/chat/ComposerCodeBlockLanguagePicker";
import { markAsOneOffEdit } from "~/composer-undo-grouping";
import { composerFormattingDelimiterForShortcut } from "~/lastcodeComposerSourceShortcuts";
import {
  toggleComposerTaskCheckbox,
  replaceComposerFenceLanguage,
  insertComposerFenceNewline,
  indentComposerFenceLines,
  type ComposerSourceEdit,
  type ComposerFormattingDelimiter,
  composerSourceFormattingEdits,
} from "~/lastcodeComposerSourceEdits";
import {
  pmToFlat,
  flatToPm,
  flatToMarkdown,
  expandedMarkdownToFlat,
  serializeEditorDoc,
  type RichDocMap,
} from "~/composer-rich-text-doc";

type ComposerSourceView = Pick<EditorView, "state" | "dispatch">;

const widgetRoots = new WeakMap<Node, Root>();

function sourceSelection(state: EditorState, map: RichDocMap) {
  return {
    from: flatToMarkdown(map, pmToFlat(map, state.selection.from)),
    to: flatToMarkdown(map, pmToFlat(map, state.selection.to)),
  };
}

function sourcePosition(map: RichDocMap, offset: number) {
  return flatToPm(map, expandedMarkdownToFlat(map, offset));
}

/** Apply only the changed source span, preserving atoms and text outside it. */
export function applyComposerSourceEdit(
  view: ComposerSourceView,
  edit: ComposerSourceEdit | null,
  replacementRange?: { from: number; to: number },
): boolean {
  if (!edit) return false;
  const map = serializeEditorDoc(view.state.doc);
  let from = 0;
  while (
    from < map.value.length &&
    from < edit.value.length &&
    map.value[from] === edit.value[from]
  )
    from++;
  let oldEnd = map.value.length,
    newEnd = edit.value.length;
  while (oldEnd > from && newEnd > from && map.value[oldEnd - 1] === edit.value[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  for (const run of map.runs) {
    if (run.kind !== "token") continue;
    const end = run.mdStart + run.mdLen;
    if (from > run.mdStart && from < end) from = run.mdStart;
    if (oldEnd > run.mdStart && oldEnd < end) {
      newEnd += end - oldEnd;
      oldEnd = end;
    }
  }
  if (replacementRange) {
    from = replacementRange.from;
    oldEnd = replacementRange.to;
    newEnd = edit.value.length - (map.value.length - oldEnd);
  }
  const tr = markAsOneOffEdit(view.state.tr);
  const text = edit.value.slice(from, newEnd);
  if (text.includes("\n")) {
    const paragraphs = text
      .split("\n")
      .map((line) =>
        view.state.schema.nodes.paragraph!.create(null, line ? view.state.schema.text(line) : null),
      );
    tr.replaceRange(
      sourcePosition(map, from),
      sourcePosition(map, oldEnd),
      new Slice(Fragment.fromArray(paragraphs), 1, 1),
    );
  } else if (from !== oldEnd || text) {
    tr.insertText(text, sourcePosition(map, from), sourcePosition(map, oldEnd));
  }
  const nextMap = serializeEditorDoc(tr.doc);
  tr.setSelection(
    TextSelection.create(
      tr.doc,
      sourcePosition(nextMap, edit.selection.from),
      sourcePosition(nextMap, edit.selection.to),
    ),
  );
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Typed delimiters wrap the selected text inside its paragraph, including Select All. */
export function wrapComposerSourceSelection(
  view: ComposerSourceView,
  from: number,
  to: number,
  opener: string,
  closer: string,
): boolean {
  const map = serializeEditorDoc(view.state.doc);
  const start = flatToPm(map, pmToFlat(map, from));
  const end = flatToPm(map, pmToFlat(map, to));
  const tr = markAsOneOffEdit(view.state.tr).insertText(closer, end).insertText(opener, start);
  tr.setSelection(TextSelection.create(tr.doc, start + opener.length, end + opener.length));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function formatSource(view: ComposerSourceView, delimiter: ComposerFormattingDelimiter): boolean {
  const map = serializeEditorDoc(view.state.doc);
  const decision = composerSourceFormattingEdits(
    map.value,
    sourceSelection(view.state, map),
    delimiter,
  );
  const tr = markAsOneOffEdit(view.state.tr);
  for (const edit of decision.edits) {
    tr.insertText(edit.text, sourcePosition(map, edit.from), sourcePosition(map, edit.to));
  }
  const nextMap = serializeEditorDoc(tr.doc);
  tr.setSelection(
    TextSelection.create(
      tr.doc,
      sourcePosition(nextMap, decision.selection.from),
      sourcePosition(nextMap, decision.selection.to),
    ),
  );
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Explicit source gestures run before the parent composer's send/continuation keys. */
export function handleComposerSourceKey(
  view: ComposerSourceView,
  event: KeyboardEvent,
  platform = navigator.platform,
): boolean {
  const preview = composerLivePreviewKey.getState(view.state);
  if (!preview?.enabled || event.isComposing || event.keyCode === 229) return false;
  const delimiter = composerFormattingDelimiterForShortcut(event, platform);
  if (delimiter) return formatSource(view, delimiter);
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (event.key !== "Enter" && event.key !== "Tab")
  )
    return false;
  const from = pmToFlat(preview.map, view.state.selection.from);
  const to = pmToFlat(preview.map, view.state.selection.to);
  const fence = composerFences(preview).find((range) => from >= range.from && to <= range.to);
  if (!fence) return false;
  const expandedFence = {
    from: flatToMarkdown(preview.map, fence.from),
    to: flatToMarkdown(preview.map, fence.to),
    contentFrom: flatToMarkdown(preview.map, fence.contentFrom),
    contentTo: flatToMarkdown(preview.map, fence.contentTo),
  };
  const selection = sourceSelection(view.state, preview.map);
  return applyComposerSourceEdit(
    view,
    event.key === "Enter"
      ? insertComposerFenceNewline(preview.map.value, selection, expandedFence)
      : indentComposerFenceLines(
          preview.map.value,
          selection,
          expandedFence,
          event.shiftKey ? "out" : "in",
        ),
  );
}

interface ComposerLivePreviewState {
  enabled: boolean;
  editable: boolean;
  theme: "light" | "dark";
  composing: boolean;
  source: string;
  parsed: boolean;
  ranges: MarkdownSourceRanges;
  map: RichDocMap;
  decorations: DecorationSet;
}

type ComposerLivePreviewMeta = { enabled?: boolean; editable?: boolean; composing?: boolean };

export const composerLivePreviewKey = new PluginKey<ComposerLivePreviewState>(
  "composer-live-preview",
);

/** Chips occupy one source position in the editable document, regardless of their label. */
function collapsedSource(state: EditorState): string {
  const lines: string[] = [];
  state.doc.forEach((node) => lines.push(node.textBetween(0, node.content.size, "", "\uFFFC")));
  return lines.join("\n");
}

function composerTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement?.classList?.contains("dark")
    ? "dark"
    : "light";
}

function parseSource(source: string, enabled: boolean): MarkdownSourceRanges {
  return enabled && source.length <= MAX_COMPOSER_LIVE_PREVIEW_LENGTH
    ? collectMarkdownSourceRanges(source)
    : { inline: [], lines: [], fences: [] };
}

const fenceCache = new WeakMap<RichDocMap, MarkdownSourceRanges["fences"]>();

/** Plain or large drafts parse fences on demand; literal fence semantics do not depend on preview. */
function composerFences(preview: ComposerLivePreviewState) {
  if (preview.parsed && !preview.composing) return preview.ranges.fences;
  let fences = fenceCache.get(preview.map);
  if (!fences) {
    fences = collectMarkdownSourceRanges(preview.source).fences;
    fenceCache.set(preview.map, fences);
  }
  return fences;
}

function decorationsForState(
  state: EditorState,
  value: Omit<ComposerLivePreviewState, "decorations">,
): DecorationSet {
  const selection = {
    from: pmToFlat(value.map, state.selection.from),
    to: pmToFlat(value.map, state.selection.to),
  };
  const presentation = buildComposerLivePreview(
    value.ranges,
    selection,
    value.enabled,
    value.source.length,
  );
  const decorations: Decoration[] = [];
  for (const range of presentation.classRanges) {
    if (range.from >= range.to) continue;
    decorations.push(
      Decoration.inline(flatToPm(value.map, range.from), flatToPm(value.map, range.to), {
        class: range.className,
      }),
    );
  }
  const lines = new Map<number, { to: number; classes: Set<string> }>();
  for (const range of presentation.lineClasses) {
    const position = state.doc.resolve(flatToPm(value.map, range.from));
    if (position.depth !== 1) continue;
    const from = position.before(1);
    const line = lines.get(from) ?? { to: position.after(1), classes: new Set<string>() };
    line.classes.add(range.className);
    lines.set(from, line);
  }
  for (const [from, line] of lines) {
    decorations.push(Decoration.node(from, line.to, { class: [...line.classes].join(" ") }));
  }
  for (const widget of presentation.widgets) {
    decorations.push(
      Decoration.widget(
        flatToPm(value.map, widget.from),
        (view, getPos) => {
          const element = document.createElement("span");
          element.contentEditable = "false";
          if (widget.kind === "bullet") {
            element.className = "composer-md-bullet";
            element.textContent = "• ";
            element.setAttribute("aria-hidden", "true");
          } else if (widget.kind === "task") {
            element.className = "composer-md-checkbox";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = widget.checked;
            input.disabled = !value.editable;
            input.setAttribute("aria-label", "Toggle task");
            element.addEventListener("mousedown", (event) => event.preventDefault());
            input.addEventListener("change", () => {
              // Native checkbox state flips before change; source alone owns its state.
              input.checked = widget.checked;
              if (!view.editable) return;
              const current = composerLivePreviewKey.getState(view.state);
              const position = getPos();
              if (!current || position === undefined) return;
              const offset = pmToFlat(current.map, position);
              const line = current.ranges.lines.find(
                (line) => line.line.kind === "task" && line.syntax[0]?.from === offset,
              );
              const checkbox = line?.syntax.at(-1);
              if (!checkbox) return;
              const map = current.map;
              applyComposerSourceEdit(
                view,
                toggleComposerTaskCheckbox(map.value, sourceSelection(view.state, map), {
                  from: flatToMarkdown(map, checkbox.from + 1),
                  to: flatToMarkdown(map, checkbox.from + 2),
                }),
              );
            });
            element.append(input);
          } else {
            element.className = "composer-md-fence-header";
            const root = createRoot(element);
            widgetRoots.set(element, root);
            queueMicrotask(() => {
              if (widgetRoots.get(element) !== root) return;
              root.render(
                createElement(ComposerCodeBlockLanguagePicker, {
                  language: widget.language,
                  theme: value.theme,
                  disabled: !value.editable,
                  onChange: (language: string) => {
                    if (!view.editable) return;
                    const current = composerLivePreviewKey.getState(view.state);
                    const position = getPos();
                    if (!current || position === undefined) return;
                    const offset = pmToFlat(current.map, position);
                    const opening = current.ranges.lines.find(
                      (line) => line.line.kind === "fenceOpen" && line.syntax[0]?.from === offset,
                    )?.line;
                    if (opening?.kind !== "fenceOpen") return;
                    const map = current.map;
                    applyComposerSourceEdit(
                      view,
                      replaceComposerFenceLanguage(
                        map.value,
                        sourceSelection(view.state, map),
                        {
                          from: flatToMarkdown(map, opening.infoFrom),
                          to: flatToMarkdown(map, opening.infoTo),
                        },
                        language,
                      ),
                    );
                    view.focus();
                  },
                }),
              );
            });
          }
          return element;
        },
        {
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
          key: `${widget.kind}:${widget.kind === "fenceHeader" ? widget.language : widget.kind === "task" ? widget.checked : ""}:${value.theme}:${value.editable}`,
          destroy(element) {
            const root = widgetRoots.get(element);
            if (root) {
              queueMicrotask(() => root.unmount());
              widgetRoots.delete(element);
            }
          },
        },
      ),
    );
  }
  if (!state.selection.empty) {
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
      if (!node.type.name.startsWith("composer-")) return true;
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "composer-chip-range-selected" }),
      );
      return false;
    });
  }
  return DecorationSet.create(state.doc, decorations);
}

export function isComposerCaretInFence(state: EditorState): boolean {
  const preview = composerLivePreviewKey.getState(state);
  if (!preview) return false;
  const from = pmToFlat(preview.map, state.selection.from);
  const to = pmToFlat(preview.map, state.selection.to);
  return composerFences(preview).some((fence) => from >= fence.from && to <= fence.to);
}

/** Formatting decorates the source document; selection and mode changes never edit its text. */
export const ComposerLivePreviewExtension = Extension.create<{
  enabled: boolean;
  editable: boolean;
}>({
  name: "composer-live-preview",
  addOptions() {
    return { enabled: false, editable: true };
  },
  addProseMirrorPlugins() {
    const enabled = this.options.enabled;
    const editable = this.options.editable;
    return [
      new Plugin<ComposerLivePreviewState>({
        key: composerLivePreviewKey,
        state: {
          init(_, state) {
            const source = collapsedSource(state);
            const value = {
              enabled,
              editable,
              theme: composerTheme(),
              composing: false,
              source,
              parsed: enabled && source.length <= MAX_COMPOSER_LIVE_PREVIEW_LENGTH,
              ranges: parseSource(source, enabled),
              map: serializeEditorDoc(state.doc),
            };
            return { ...value, decorations: decorationsForState(state, value) };
          },
          apply(transaction, previous, _oldState, state) {
            const meta = transaction.getMeta(composerLivePreviewKey) as
              | ComposerLivePreviewMeta
              | undefined;
            const theme = composerTheme();
            if (
              !transaction.docChanged &&
              !transaction.selectionSet &&
              !meta &&
              theme === previous.theme
            )
              return previous;
            const composing = meta?.composing ?? previous.composing;
            const source = transaction.docChanged ? collapsedSource(state) : previous.source;
            const enabled = meta?.enabled ?? previous.enabled;
            const value = {
              enabled,
              editable: meta?.editable ?? previous.editable,
              theme,
              parsed: enabled && source.length <= MAX_COMPOSER_LIVE_PREVIEW_LENGTH,
              composing,
              source,
              ranges:
                !composing &&
                (transaction.docChanged || previous.composing || enabled !== previous.enabled)
                  ? parseSource(source, enabled)
                  : previous.ranges,
              map: transaction.docChanged ? serializeEditorDoc(state.doc) : previous.map,
            };
            return {
              ...value,
              decorations: composing
                ? previous.decorations.map(transaction.mapping, state.doc)
                : decorationsForState(state, value),
            };
          },
        },
        props: {
          decorations(state) {
            return composerLivePreviewKey.getState(state)?.decorations;
          },
          handleDOMEvents: {
            compositionstart(view) {
              view.dispatch(
                view.state.tr
                  .setMeta(composerLivePreviewKey, { composing: true })
                  .setMeta("addToHistory", false),
              );
              return false;
            },
            compositionend(view) {
              view.dispatch(
                view.state.tr
                  .setMeta(composerLivePreviewKey, { composing: false })
                  .setMeta("addToHistory", false),
              );
              return false;
            },
          },
        },
      }),
    ];
  },
});
