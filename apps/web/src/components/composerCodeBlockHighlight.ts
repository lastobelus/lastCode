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

// Tokenizing larger fences can stall the main thread.
const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 20_000;

// Keep mapped colors while typing in long fences, then refresh after a pause.
const DEFERRED_HIGHLIGHT_CODE_BLOCK_LENGTH = 2_000;
const DEFERRED_HIGHLIGHT_DELAY_MS = 300;

function shouldHighlightCodeBlock(code: string): boolean {
  return code.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH;
}

function blockSignature(block: { language: string; code: string }, theme: DiffThemeName): string {
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
  return preview.ranges.fences
    .map((fence) => ({
      ...composerFenceCode(preview.source, fence),
      language: fence.language || "text",
    }))
    .filter((block) => shouldHighlightCodeBlock(block.code));
}

export function composerCodeBlockHighlight(options: {
  resolveTheme: () => DiffThemeName;
}): Extension {
  return Extension.create({
    name: "composerCodeBlockHighlight",
    // Its apply reads the preview's newly parsed ranges and position map.
    priority: 90,

    addProseMirrorPlugins() {
      // Prune obsolete signatures each scan so the cache is bounded by the document without evicting live
      // blocks.
      const cache = new Map<string, HighlightedBlock>();
      // Track live signatures so late tokenization cannot restore edited-away blocks.
      let live = new Set<string>();

      return [
        new Plugin<DecorationSet>({
          key: composerCodeBlockHighlightKey,

          state: {
            init: () => DecorationSet.empty,
            apply(transaction, value, _oldState, newState) {
              const mapped = value.map(transaction.mapping, transaction.doc);
              const preview = composerLivePreviewKey.getState(newState);
              if (!preview?.enabled) return DecorationSet.empty;
              if (
                preview.composing ||
                (!transaction.docChanged &&
                  !transaction.getMeta(composerCodeBlockHighlightKey) &&
                  !transaction.getMeta(composerLivePreviewKey))
              ) {
                return mapped;
              }
              return buildDecorations(newState, cache, options.resolveTheme(), mapped);
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
            let deferredRefresh: ReturnType<typeof setTimeout> | undefined;

            // Repaints and selection changes must not restart the debounce.
            const refresh = (deferLong: boolean) => {
              const theme = options.resolveTheme();
              const preview = composerLivePreviewKey.getState(view.state);
              // Composition maps the existing colors until its final ranges are parsed.
              if (preview?.composing) return;
              const themeChanged = theme !== paintedTheme;
              paintedTheme = theme;
              // Selection changes cannot affect tokens; avoid rebuilding every block's text signature.
              if (
                !themeChanged &&
                view.state.doc === scannedDoc &&
                preview?.ranges === scannedRanges &&
                preview?.enabled === scannedEnabled
              )
                return;
              clearTimeout(deferredRefresh);
              scannedDoc = view.state.doc;
              scannedRanges = preview?.ranges;
              scannedEnabled = preview?.enabled;
              const blocks = collectCodeBlocks(view.state);
              const signatures = new Set(blocks.map((block) => blockSignature(block, theme)));
              live = signatures;
              for (const signature of cache.keys()) {
                if (!live.has(signature)) cache.delete(signature);
              }
              const missing = blocks.filter((block) => !cache.has(blockSignature(block, theme)));
              const pending =
                deferLong && !themeChanged
                  ? missing.filter(
                      (block) => block.code.length <= DEFERRED_HIGHLIGHT_CODE_BLOCK_LENGTH,
                    )
                  : missing;
              if (pending.length < missing.length) {
                deferredRefresh = setTimeout(() => {
                  scannedDoc = null;
                  refresh(false);
                }, DEFERRED_HIGHLIGHT_DELAY_MS);
              }
              if (pending.length === 0) {
                if (themeChanged) {
                  view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
                }
                return;
              }

              void Promise.allSettled(
                pending.map(async (block) => {
                  const { code, language } = block;
                  const signature = blockSignature(block, theme);
                  const highlighter = await getSyntaxHighlighterPromise(language).catch(() => null);
                  if (disposed || live !== signatures || cache.has(signature)) return;
                  cache.set(signature, {
                    signature,
                    decorations: highlighter
                      ? tokenizeBlock(highlighter, code, language, theme)
                      : [],
                  });
                }),
              ).then(() => {
                if (disposed || live !== signatures) return;
                view.dispatch(view.state.tr.setMeta(composerCodeBlockHighlightKey, true));
              });
            };

            refresh(false);
            // The theme lives on <html>, outside the editor, so nothing would
            // otherwise tell the view a repaint is due.
            const themeObserver = new MutationObserver(() => refresh(false));
            themeObserver.observe(document.documentElement, {
              attributeFilter: ["class"],
            });

            return {
              update: () => refresh(true),
              destroy() {
                disposed = true;
                clearTimeout(deferredRefresh);
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
  previous: DecorationSet,
): DecorationSet {
  const decorations: Decoration[] = [];
  const preview = composerLivePreviewKey.getState(state);
  if (!preview?.enabled || preview.composing) return DecorationSet.empty;
  for (const block of collectCodeBlocks(state)) {
    const highlighted = cache.get(blockSignature(block, theme));
    if (!highlighted) {
      // Clip mapped colors to each source code line, excluding quote/list prefixes
      // and any prose exposed when an edited fence splits into separate fences.
      for (const line of block.lines) {
        const start = flatToPm(preview.map, line.sourceFrom);
        const end = flatToPm(preview.map, line.sourceFrom + line.codeTo - line.codeFrom);
        for (const decoration of previous.find(start, end)) {
          const from = Math.max(start, decoration.from);
          const to = Math.min(end, decoration.to);
          if (from < to) decorations.push(colorDecoration(from, to, decoration.spec.color));
        }
      }
      continue;
    }
    for (const decoration of highlighted.decorations) {
      const from = sourceOffset(block.lines, decoration.from);
      const to = sourceOffset(block.lines, decoration.to);
      if (from === undefined || to === undefined) continue;
      decorations.push(
        colorDecoration(flatToPm(preview.map, from), flatToPm(preview.map, to), decoration.color),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

// Keep the color available when clipping mapped decorations to a fence.
function colorDecoration(from: number, to: number, color: string): Decoration {
  return Decoration.inline(from, to, { style: `color:${color}` }, { color });
}
