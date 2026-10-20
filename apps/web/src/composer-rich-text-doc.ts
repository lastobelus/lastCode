import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { collectMarkdownSourceRanges } from "@t3tools/shared/lastcodeMarkdownSourceRanges";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { markdownMathRanges } from "@t3tools/shared/markdownMath";

export type SkillMeta = { label: string; description: string | null };

type InlineJson = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
};
/** `styling` retains the upstream caller option; fence text stays literal in either preview mode. */
type BuildOptions = { literalText?: boolean; literalLength?: number; styling?: boolean };

function randomNodeKey(): string {
  return `tiptap-${Math.random().toString(36).slice(2)}`;
}

function atomJsonForSegment(
  segment: Exclude<ReturnType<typeof splitPromptIntoComposerSegments>[number], { type: "text" }>,
  skillLabelFor: (name: string) => SkillMeta | null,
): InlineJson | null {
  if (segment.type === "mention") {
    return {
      type: "composer-mention",
      attrs: { path: segment.path, source: segment.source },
    };
  }
  if (segment.type === "skill") {
    const meta = skillLabelFor(segment.name);
    if (!meta) return null;
    return {
      type: "composer-skill",
      attrs: {
        skillName: segment.name,
        skillLabel: meta.label,
        skillDescription: meta.description,
      },
    };
  }
  if (segment.type === "citation") {
    return {
      type: "composer-citation",
      attrs: { citation: segment.citation, source: segment.source, citeKey: randomNodeKey() },
    };
  }
  return {
    type: "composer-context-reference",
    attrs: {
      kind: segment.kind,
      contextId: segment.contextId,
      label: segment.label,
      source: segment.source,
    },
  };
}

/** Source text stays literal; only recognized composer tokens become inline atoms. */
export function buildTiptapContent(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options?: BuildOptions,
): Record<string, unknown>[] {
  const paragraphs: Array<{ type: "paragraph"; content: InlineJson[] }> = [
    { type: "paragraph", content: [] },
  ];
  const appendText = (text: string) => {
    text.split("\n").forEach((piece, index) => {
      if (index > 0) paragraphs.push({ type: "paragraph", content: [] });
      if (!piece) return;
      const inline = paragraphs[paragraphs.length - 1]!.content;
      const previous = inline[inline.length - 1];
      if (previous?.type === "text") previous.text = (previous.text ?? "") + piece;
      else inline.push({ type: "text", text: piece });
    });
  };
  if (options?.literalText) {
    appendText(value);
    return paragraphs;
  }

  const fences = collectMarkdownSourceRanges(value).fences;
  const formulas = markdownMathRanges(value);
  const literalLength = Math.max(0, Math.min(options?.literalLength ?? 0, value.length));
  appendText(value.slice(0, literalLength));
  let offset = literalLength;
  for (const segment of splitPromptIntoComposerSegments(value.slice(literalLength))) {
    const source = segment.type === "text" ? segment.text : segment.source;
    const end = offset + source.length;
    if (
      segment.type === "text" ||
      fences.some((fence) => offset < fence.to && end > fence.from) ||
      formulas.some((formula) => offset < formula.end && end > formula.start)
    ) {
      appendText(source);
    } else {
      const atom = atomJsonForSegment(segment, skillLabelFor);
      if (atom) paragraphs[paragraphs.length - 1]!.content.push(atom);
      else appendText(source);
    }
    offset = end;
  }
  return paragraphs;
}

export function buildDocJson(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options?: BuildOptions,
) {
  return { type: "doc", content: buildTiptapContent(value, skillLabelFor, options) };
}

export interface RichRun {
  kind: "text" | "token" | "break";
  /** Source characters count literally; an inline atom occupies one position. */
  flatStart: number;
  docLen: number;
  mdLen: number;
  pmPos: number;
  /** Paragraph boundaries span two ProseMirror positions and one source newline. */
  nextPmPos?: number;
  mdStart: number;
  nodeName?: string;
}

export interface RichDocMap {
  value: string;
  runs: RichRun[];
  docLength: number;
  contextIds: string[];
}

function readAtomSource(node: ProseMirrorNode): string {
  const attrs = node.attrs as Record<string, unknown>;
  switch (node.type.name) {
    case "composer-mention":
    case "composer-citation":
    case "composer-context-reference":
      return typeof attrs.source === "string" ? attrs.source : "";
    case "composer-skill": {
      const name = typeof attrs.skillName === "string" ? attrs.skillName : "";
      return name ? `$${name}` : "";
    }
    default:
      return "";
  }
}

export interface SkillChipReplacement {
  from: number;
  to: number;
  node: ProseMirrorNode;
}

/** Preserve citation node identities when provider skills load or change. */
export function skillChipReplacements(
  doc: ProseMirrorNode,
  skillLabelFor: (name: string) => SkillMeta | null,
): SkillChipReplacement[] {
  const schema = doc.type.schema;
  const skillType = schema.nodes["composer-skill"];
  if (!skillType) return [];
  const replacements: SkillChipReplacement[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== skillType) return;
    const name = typeof node.attrs.skillName === "string" ? node.attrs.skillName : "";
    if (name && !skillLabelFor(name)) {
      replacements.push({
        from: pos,
        to: pos + node.nodeSize,
        node: schema.text(readAtomSource(node), node.marks),
      });
    }
  });
  const map = serializeEditorDoc(doc);
  const fences = collectMarkdownSourceRanges(map.value).fences;
  const formulas = markdownMathRanges(map.value);
  let end = 0;
  for (const segment of splitPromptIntoComposerSegments(map.value)) {
    const start = end;
    end += segment.type === "text" ? segment.text.length : segment.source.length;
    if (
      segment.type !== "skill" ||
      fences.some((fence) => start < fence.to && end > fence.from) ||
      formulas.some((formula) => start < formula.end && end > formula.start)
    )
      continue;
    const meta = skillLabelFor(segment.name);
    if (!meta) continue;
    const run = map.runs.find(
      (candidate) =>
        candidate.kind === "text" &&
        start >= candidate.mdStart &&
        end <= candidate.mdStart + candidate.docLen,
    );
    if (!run) continue;
    const from = run.pmPos + start - run.mdStart;
    replacements.push({
      from,
      to: from + segment.source.length,
      node: skillType.create(
        { skillName: segment.name, skillLabel: meta.label, skillDescription: meta.description },
        null,
        doc.nodeAt(from)?.marks,
      ),
    });
  }
  return replacements.sort((left, right) => right.from - left.from);
}

/** Serialize plain paragraphs and atoms while retaining each editable empty line. */
export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const runs: RichRun[] = [];
  let value = "";
  let flat = 0;
  let previousEnd = 1;
  const append = (
    kind: RichRun["kind"],
    source: string,
    docLen: number,
    pmPos: number,
    extra: Pick<RichRun, "nextPmPos" | "nodeName"> = {},
  ) => {
    runs.push({
      kind,
      flatStart: flat,
      docLen,
      mdLen: source.length,
      pmPos,
      mdStart: value.length,
      ...extra,
    });
    value += source;
    flat += docLen;
  };
  doc.forEach((paragraph, blockPos, index) => {
    const contentStart = blockPos + 1;
    if (index > 0) append("break", "\n", 1, previousEnd, { nextPmPos: contentStart });
    if (paragraph.childCount === 0) append("text", "", 0, contentStart);
    paragraph.forEach((node, inlinePos) => {
      const source = node.isText ? (node.text ?? "") : readAtomSource(node);
      append(
        node.isText ? "text" : "token",
        source,
        node.nodeSize,
        contentStart + inlinePos,
        node.isText ? {} : { nodeName: node.type.name },
      );
    });
    previousEnd = contentStart + paragraph.content.size;
  });
  return { value, runs, docLength: flat, contextIds: collectInlineContextIds(value) };
}

/** Expand atoms at their edges; source text and paragraph newlines map one-to-one. */
export function flatToMarkdown(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded <= run.flatStart + run.docLen) {
      const within = bounded - run.flatStart;
      return run.mdStart + (run.kind === "token" && within > 0 ? run.mdLen : within);
    }
  }
  return map.value.length;
}

/** Source offsets inside an atom clamp to its leading edge; its source end maps after it. */
export function expandedMarkdownToFlat(map: RichDocMap, offset: number): number {
  const bounded = Math.max(0, Math.min(offset, map.value.length));
  for (const run of map.runs) {
    if (bounded <= run.mdStart + run.mdLen) {
      const within = bounded - run.mdStart;
      if (run.kind === "token") {
        return run.flatStart + (within === run.mdLen ? run.docLen : 0);
      }
      return run.flatStart + within;
    }
  }
  return map.docLength;
}

export function flatToPm(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded <= run.flatStart + run.docLen) {
      const within = bounded - run.flatStart;
      if (run.kind === "break") return within === 0 ? run.pmPos : run.nextPmPos!;
      return run.pmPos + within;
    }
  }
  const last = map.runs[map.runs.length - 1];
  return last ? last.pmPos + last.docLen : 1;
}

export function pmToFlat(map: RichDocMap, pmPos: number): number {
  for (const run of map.runs) {
    if (pmPos < run.pmPos) return run.flatStart;
    if (run.kind === "break") {
      if (pmPos <= run.nextPmPos!) return run.flatStart + (pmPos > run.pmPos ? 1 : 0);
    } else if (pmPos <= run.pmPos + run.docLen) {
      return run.flatStart + (pmPos - run.pmPos);
    }
  }
  return map.docLength;
}

/** Copy and cut preserve the exact source, including delimiter text and whole atom sources. */
export function serializeSelection(doc: ProseMirrorNode, from: number, to: number): string {
  const map = serializeEditorDoc(doc);
  return map.value.slice(
    flatToMarkdown(map, pmToFlat(map, from)),
    flatToMarkdown(map, pmToFlat(map, to)),
  );
}
