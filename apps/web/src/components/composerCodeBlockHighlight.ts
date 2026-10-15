import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import type { DiffThemeName } from "~/lib/diffRendering";
import { flatToPm } from "~/composer-rich-text-doc";
import { composerFenceCode } from "~/lastcodeComposerSourceEdits";
import { MAX_COMPOSER_LIVE_PREVIEW_LENGTH } from "~/lastcodeComposerLivePreview";
import { composerLivePreviewKey } from "~/lastcodeComposerLivePreviewTiptap";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

interface HighlightedBlock {
  /** Guards against repainting a block whose text and language are unchanged. */
  readonly signature: string;
  readonly decorations: ReadonlyArray<{ from: number; to: number; color: string }>;
}

const composerCodeBlockHighlightKey = new PluginKey<DecorationSet>("composerCodeBlockHighlight");

function blockSignature(block: { language: string; code: string }, theme: DiffThemeName): string {
  // A separator that cannot occur in a language name keeps the parts distinct.
  return [theme, block.language, block.code].join("\u0000");
}

/**
 * The presentation parser already found the fences; reuse its collapsed
 * source so chips before a fence do not shift the token offsets.
 */
function collectCodeBlocks(state: EditorState) {
  const preview = composerLivePreviewKey.getState(state);
  if (
    !preview?.enabled ||
    preview.composing ||
    preview.source.length > MAX_COMPOSER_LIVE_PREVIEW_LENGTH
  )
    return [];
  return preview.ranges.fences.map((fence) => ({
    ...composerFenceCode(preview.source, fence),
    language: fence.language || "text",
  }));
}

/**
 * Highlights composer code blocks with the same Shiki instance the chat view
 * uses, painted as inline decorations so the text nodes stay editable.
 *
 * Highlighting is asynchronous and per block: a keystroke re-tokenizes only the
 * block that changed, and only after its highlighter has resolved. Blocks whose
 * text and language are unchanged reuse their previous decorations.
 */
export function composerCodeBlockHighlight(options: {
  resolveTheme: () => DiffThemeName;
}): Extension {
  return Extension.create({
    name: "composerCodeBlockHighlight",
    // Its apply reads the preview's newly parsed ranges and position map.
    priority: 90,

    addProseMirrorPlugins() {
      // Every keystroke in a code block mints a new signature, so each scan
      // drops the signatures the document no longer holds. The cache is then
      // bounded by the document itself, and no block it holds is ever evicted.
      const cache = new Map<string, HighlightedBlock>();
      // The latest scan's signatures, so a tokenize that resolves after its
      // block was edited away does not put it back.
      let live = new Set<string>();

      return [
        new Plugin<DecorationSet>({
          key: composerCodeBlockHighlightKey,

          state: {
            init: () => DecorationSet.empty,
            apply(transaction, value, _oldState, newState) {
              const preview = composerLivePreviewKey.getState(newState);
              if (!preview?.enabled) return DecorationSet.empty;
              if (
                preview.composing ||
                (!transaction.docChanged &&
                  !transaction.getMeta(composerCodeBlockHighlightKey) &&
                  !transaction.getMeta(composerLivePreviewKey))
              ) {
                return value.map(transaction.mapping, transaction.doc);
              }
              return buildDecorations(newState, cache, options.resolveTheme());
            },
          },

          props: {
            decorations(state) {
              return composerCodeBlockHighlightKey.getState(state);
            },
          },

          view(view) {
            let disposed = false;
            let paintedTheme = options.resolveTheme();
            let scannedDoc: ProseMirrorNode | null = null;
            let scannedRanges = composerLivePreviewKey.getState(view.state)?.ranges;
            let scannedEnabled: boolean | undefined;

            /**
             * Tokenizes any block missing from the cache, then repaints once.
             * Returning early when nothing is pending is what stops the
             * dispatch below from re-triggering this on its own update.
             */
            const refresh = () => {
              const theme = options.resolveTheme();
              const preview = composerLivePreviewKey.getState(view.state);
              // Composition maps the existing colors until its final ranges are parsed.
              if (preview?.composing) return;
              const themeChanged = theme !== paintedTheme;
              paintedTheme = theme;
              // A selection change cannot alter what needs tokenizing, and
              // building a signature means concatenating every block's text.
              if (
                !themeChanged &&
                view.state.doc === scannedDoc &&
                preview?.ranges === scannedRanges &&
                preview?.enabled === scannedEnabled
              )
                return;
              scannedDoc = view.state.doc;
              scannedRanges = preview?.ranges;
              scannedEnabled = preview?.enabled;
              const blocks = collectCodeBlocks(view.state);
              live = new Set(blocks.map((block) => blockSignature(block, theme)));
              for (const signature of cache.keys()) {
                if (!live.has(signature)) cache.delete(signature);
              }
              const pending = blocks.filter((block) => !cache.has(blockSignature(block, theme)));
              if (pending.length === 0) {
                // A theme switch keeps every signature but changes which one
                // applies, so the painted decorations still have to be rebuilt.
                if (themeChanged) {
                  view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
                }
                return;
              }

              // Settled rather than all: a block whose highlighter fails to
              // load stays plain, and the others are still painted.
              void Promise.allSettled(
                pending.map(async (block) => {
                  const { code, language } = block;
                  const signature = blockSignature(block, theme);
                  const highlighter = await getSyntaxHighlighterPromise(language);
                  if (disposed || cache.has(signature) || !live.has(signature)) return;
                  cache.set(signature, {
                    signature,
                    decorations: tokenizeBlock(highlighter, code, language, theme),
                  });
                }),
              ).then(() => {
                if (disposed) return;
                view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
              });
            };

            refresh();
            // The theme lives on <html>, outside the editor, so nothing would
            // otherwise tell the view a repaint is due.
            const themeObserver = new MutationObserver(refresh);
            themeObserver.observe(document.documentElement, {
              attributeFilter: ["class"],
            });

            return {
              update: refresh,
              destroy() {
                disposed = true;
                themeObserver.disconnect();
              },
            };
          },
        }),
      ];
    },
  });
}

type Highlighter = Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>;

/** Flattens Shiki's line/token structure into offsets within the block's text. */
export function tokenizeBlock(
  highlighter: Highlighter,
  code: string,
  language: string,
  theme: DiffThemeName,
): ReadonlyArray<{ from: number; to: number; color: string }> {
  let tokens;
  try {
    tokens = highlighter.codeToTokens(code, { lang: language, theme }).tokens;
  } catch {
    // An unsupported language should read as plain text, not break the editor.
    return [];
  }

  const decorations: Array<{ from: number; to: number; color: string }> = [];
  let offset = 0;
  for (const [lineIndex, line] of tokens.entries()) {
    // The separator between lines, which Shiki drops; CRLF is two characters.
    if (lineIndex > 0) offset += code.startsWith("\r\n", offset) ? 2 : 1;
    for (const token of line) {
      const length = token.content.length;
      if (token.color && token.content.trim()) {
        decorations.push({ from: offset, to: offset + length, color: token.color });
      }
      offset += length;
    }
  }
  return decorations;
}

/** Shiki offsets belong to code with container prefixes removed. */
function sourceOffset(
  lines: ReturnType<typeof composerFenceCode>["lines"],
  offset: number,
): number | undefined {
  const line = lines.find((line) => offset >= line.codeFrom && offset <= line.codeTo);
  return line ? line.sourceFrom + offset - line.codeFrom : undefined;
}

function buildDecorations(
  state: EditorState,
  cache: Map<string, HighlightedBlock>,
  theme: DiffThemeName,
): DecorationSet {
  const decorations: Decoration[] = [];
  const preview = composerLivePreviewKey.getState(state);
  if (!preview?.enabled || preview.composing) return DecorationSet.empty;
  for (const block of collectCodeBlocks(state)) {
    const highlighted = cache.get(blockSignature(block, theme));
    if (!highlighted) continue;
    for (const decoration of highlighted.decorations) {
      const from = sourceOffset(block.lines, decoration.from);
      const to = sourceOffset(block.lines, decoration.to);
      if (from === undefined || to === undefined) continue;
      decorations.push(
        Decoration.inline(flatToPm(preview.map, from), flatToPm(preview.map, to), {
          style: `color:${decoration.color}`,
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}
