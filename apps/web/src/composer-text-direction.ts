import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { textDirection, type TextDirection } from "~/textDirection";
import { collectMarkdownSourceRanges } from "@t3tools/shared/lastcodeMarkdownSourceRanges";
import { MAX_COMPOSER_LIVE_PREVIEW_LENGTH } from "~/lastcodeComposerLivePreview";

interface ComposerTextDirections {
  /** One entry per top-level block. */
  readonly blocks: ReadonlyArray<TextDirection | null>;
  readonly decorations: DecorationSet;
}

// Documents are immutable, so the selection and decoration readers share one parse per edit.
const docDirections = new WeakMap<ProseMirrorNode, ComposerTextDirections>();

/** Source paragraphs share their list or quote direction; code stays left to right. */
export function composerTextDirections(doc: ProseMirrorNode): ComposerTextDirections {
  const cached = docDirections.get(doc);
  if (cached) return cached;
  const sourceLines: string[] = [];
  doc.forEach((block) => sourceLines.push(block.textBetween(0, block.content.size, "", "\uFFFC")));
  const source = sourceLines.join("\n");
  const ranges =
    source.length <= MAX_COMPOSER_LIVE_PREVIEW_LENGTH
      ? collectMarkdownSourceRanges(source)
      : { inline: [], lines: [], fences: [] };
  let prose = source;
  for (const inline of ranges.inline) {
    if (inline.kind !== "inlineCode") continue;
    prose =
      prose.slice(0, inline.from) + " ".repeat(inline.to - inline.from) + prose.slice(inline.to);
  }
  const containers = ranges.lines
    .filter(({ line }) => ["quote", "bullet", "ordered", "task"].includes(line.kind))
    .map(({ blockFrom, blockTo, line }) => ({
      from: blockFrom,
      to: blockTo,
      quote: line.kind === "quote",
    }))
    .sort((left, right) => left.from - right.from || right.to - left.to);
  const groups: Array<{ from: number; to: number; quote: boolean }> = [];
  for (const container of containers) {
    const previous = groups.at(-1);
    if (
      previous &&
      (container.from <= previous.to ||
        (!container.quote && !previous.quote && !source.slice(previous.to, container.from).trim()))
    ) {
      previous.to = Math.max(previous.to, container.to);
    } else {
      groups.push({ ...container });
    }
  }
  const groupDirections = groups.map((group) => ({
    ...group,
    dir: textDirection(prose.slice(group.from, group.to)) ?? null,
  }));
  const codeLines = new Set(
    ranges.lines
      .filter(({ line }) =>
        ["fenceOpen", "fenceBody", "fenceClose", "indentedCode"].includes(line.kind),
      )
      .map(({ lineFrom }) => lineFrom),
  );
  const blocks: Array<TextDirection | null> = [];
  const decorations: Decoration[] = [];
  let previous: TextDirection | null = null;
  let sourceOffset = 0;
  let groupIndex = 0;
  doc.forEach((block, offset, index) => {
    const line = sourceLines[index]!;
    const code = codeLines.has(sourceOffset);
    while (groupDirections[groupIndex] && sourceOffset >= groupDirections[groupIndex]!.to) {
      groupIndex++;
    }
    const group = groupDirections[groupIndex];
    const containerDirection = group && sourceOffset >= group.from ? group.dir : null;
    const dir = code
      ? "ltr"
      : (containerDirection ??
        textDirection(prose.slice(sourceOffset, sourceOffset + line.length)) ??
        previous);
    blocks.push(dir);
    if (dir) decorations.push(Decoration.node(offset, offset + block.nodeSize, { dir }));
    if (!code) previous = dir;
    sourceOffset += line.length + 1;
  });
  const directions = { blocks, decorations: DecorationSet.create(doc, decorations) };
  docDirections.set(doc, directions);
  return directions;
}

export function caretLineDirection(state: EditorState): TextDirection | null {
  return composerTextDirections(state.doc).blocks[state.selection.$head.index(0)] ?? null;
}

export const ComposerTextDirectionExtension = Extension.create({
  name: "composer-text-direction",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("composer-text-direction"),
        props: {
          decorations: (state) => composerTextDirections(state.doc).decorations,
          // On Chrome, ProseMirror reads the arrow keys' direction from the
          // editor root, so the root follows the line holding the caret.
          attributes: (state): Record<string, string> => {
            const dir = caretLineDirection(state);
            return dir ? { dir } : {};
          },
        },
      }),
    ];
  },
});
