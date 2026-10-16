import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import {
  buildDocJson,
  expandedMarkdownToFlat,
  flatToMarkdown,
  flatToPm,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
} from "./composer-rich-text-doc";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    "composer-mention": {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { path: { default: "" }, source: { default: "" } },
    },
    "composer-skill": {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        skillName: { default: "" },
        skillLabel: { default: "" },
        skillDescription: { default: null },
      },
    },
    "composer-citation": {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { citation: { default: null }, source: { default: "" }, citeKey: { default: "" } },
    },
    "composer-context-reference": {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        kind: { default: "" },
        contextId: { default: "" },
        label: { default: "" },
        source: { default: "" },
      },
    },
  },
});
const skillLabelFor = (name: string) => ({ label: `Skill ${name}`, description: "A skill" });
const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("test-environment"),
  threadId: ThreadId.make("test-thread"),
  messageId: MessageId.make("test-message"),
  text: "Use **literal** source 雪",
  start: 0,
  end: 24,
  prefix: "",
  suffix: "",
};
const citationSource = serializeAssistantCitation(citation);
const contextSource = "[Terminal lines](t3-context://v1/terminal/terminal_1)";

function makeDoc(value: string, options?: Parameters<typeof buildDocJson>[2]) {
  const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(value, skillLabelFor, options));
  doc.check();
  return doc;
}
function atoms(doc: ProseMirrorNode) {
  const result: ProseMirrorNode[] = [];
  doc.descendants((node) => {
    if (node.isAtom && !node.isText) result.push(node);
  });
  return result;
}

function assertMappingRoundTrip(doc: ProseMirrorNode) {
  const map = serializeEditorDoc(doc);
  for (let offset = 0; offset <= map.docLength; offset++) {
    const pm = flatToPm(map, offset);
    expect(doc.resolve(pm).parent.type.name).toBe("paragraph");
    expect(pmToFlat(map, pm)).toBe(offset);
    expect(expandedMarkdownToFlat(map, flatToMarkdown(map, offset))).toBe(offset);
  }
}

describe("plain source document", () => {
  it.each([
    "",
    "\n\n",
    "clean _build and node_",
    "clean _build and node_modules",
    "clean `_build` and `node_modules`",
    "***nested*** _other_ __same spelling__ ~~strike~~ ` **literal** `",
    "# title\n> > quote\n\n- [X]\tTask\n  3) item\n---\n",
    "```ts meta\n\ncode\n```\n\n~~~\nopen fence\n",
    "heading\n======\n\nheading two\n------",
    "line one\r\nline two\r\n",
  ])("preserves every Markdown source character in %j", (value) => {
    const doc = makeDoc(value);
    expect(doc.childCount).toBe(value.split("\n").length);
    doc.forEach((paragraph) => {
      expect(paragraph.type.name).toBe("paragraph");
      paragraph.forEach((node) => expect(node.marks).toEqual([]));
    });
    expect(serializeEditorDoc(doc).value).toBe(value);
    expect(serializeSelection(doc, 1, doc.content.size - 1)).toBe(value);
    assertMappingRoundTrip(doc);
  });

  it("preserves source through delimiter edits and paragraph splits", () => {
    const doc = makeDoc("clean _build and node_modules");
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 7) });
    state = state.apply(state.tr.insertText("`"));
    expect(serializeEditorDoc(state.doc).value).toBe("clean `_build and node_modules");
    state = state.apply(state.tr.delete(7, 8));
    expect(serializeEditorDoc(state.doc).value).toBe("clean _build and node_modules");
    state = state.apply(state.tr.split(13));
    expect(serializeEditorDoc(state.doc).value).toBe("clean _build\n and node_modules");
    assertMappingRoundTrip(state.doc);
  });

  it("bypasses every atom for literal answers while retaining exact source", () => {
    const value = `**keep** @README.md $review ${citationSource} ${contextSource}\r\n\n`;
    const doc = makeDoc(value, { literalText: true, styling: true });
    expect(atoms(doc)).toEqual([]);
    expect(serializeEditorDoc(doc).value).toBe(value);
    expect(serializeSelection(doc, 1, doc.content.size - 1)).toBe(value);
    assertMappingRoundTrip(doc);
  });

  it("keeps a leading literal paste slice across newlines without disabling later atoms", () => {
    const literal = "@README.md \n$review ";
    const value = `${literal}@AGENTS.md later`;
    const doc = makeDoc(value, { literalLength: literal.length });
    expect(atoms(doc).map((node) => node.attrs.path)).toEqual(["AGENTS.md"]);
    expect(serializeEditorDoc(doc).value).toBe(value);
    expect(doc.childCount).toBe(2);
    assertMappingRoundTrip(doc);
  });

  it("does not confuse literal U+FFFC characters with actual atoms", () => {
    const value = "\uFFFC @README.md \uFFFC $review\n";
    const doc = makeDoc(value);
    expect(atoms(doc).map((node) => node.type.name)).toEqual([
      "composer-mention",
      "composer-skill",
    ]);
    expect(serializeEditorDoc(doc).value).toBe(value);
    assertMappingRoundTrip(doc);
  });
});

describe("composer atom fidelity", () => {
  it("retains all four atom attributes and their serialized source", () => {
    const mention = "[config#draft?.json](config%23draft%3F.json)";
    const value = `${mention} $review ${citationSource}${contextSource}`;
    const doc = makeDoc(value);
    const [file, skill, quote, context] = atoms(doc);
    expect(file?.attrs).toEqual({ path: "config#draft?.json", source: mention });
    expect(skill?.attrs).toEqual({
      skillName: "review",
      skillLabel: "Skill review",
      skillDescription: "A skill",
    });
    expect(quote?.attrs).toMatchObject({ citation, source: citationSource });
    expect(quote?.attrs.citeKey).toMatch(/^tiptap-/);
    expect(context?.attrs).toEqual({
      kind: "terminal",
      contextId: "terminal_1",
      label: "Terminal lines",
      source: contextSource,
    });
    expect(serializeEditorDoc(doc).value).toBe(value);
    expect(serializeEditorDoc(doc).contextIds).toEqual(["terminal_1"]);
    assertMappingRoundTrip(doc);
  });

  it("preserves adjacent citations and context atoms at the document edges", () => {
    const source = `${citationSource}${contextSource}${citationSource}`;
    const doc = makeDoc(source);
    expect(atoms(doc)).toHaveLength(3);
    const map = serializeEditorDoc(doc);
    expect(map.docLength).toBe(3);
    expect([0, 1, 2, 3].map((offset) => flatToMarkdown(map, offset))).toEqual([
      0,
      citationSource.length,
      citationSource.length + contextSource.length,
      source.length,
    ]);
    expect(serializeSelection(doc, 1, 2)).toBe(citationSource);
    expect(serializeSelection(doc, 2, 3)).toBe(contextSource);
    expect(serializeSelection(doc, 1, 4)).toBe(source);
    assertMappingRoundTrip(doc);
  });

  it("keeps context IDs unique and in source order, including literal fence references", () => {
    const second = "[Other](t3-context://v1/file/file_2)";
    const source = `${contextSource}${second}${contextSource}\n\`\`\`\n${second}\n\`\`\``;
    const map = serializeEditorDoc(makeDoc(source, { styling: true }));
    expect(map.value).toBe(source);
    expect(map.contextIds).toEqual(["terminal_1", "file_2"]);
  });

  it("preserves the existing whitespace policy when rebuilding a wrapped file-link fixture", () => {
    const source = "**[package.json](package.json)** ";
    expect(splitPromptIntoComposerSegments(source)).toEqual([{ type: "text", text: source }]);
    const rebuilt = makeDoc(source);
    expect(atoms(rebuilt)).toEqual([]);
    expect(serializeEditorDoc(rebuilt).value).toBe(source);
  });

  it("retains an existing file atom when source delimiters are typed around it", () => {
    const mentionSource = "[package.json](package.json)";
    const original = makeDoc(`${mentionSource} `);
    expect(atoms(original)).toHaveLength(1);
    let state = EditorState.create({ doc: original });
    state = state.apply(state.tr.insertText("**", 1));
    state = state.apply(state.tr.insertText("**", 4));
    expect(atoms(state.doc)).toHaveLength(1);
    expect(serializeEditorDoc(state.doc).value).toBe(`**${mentionSource}** `);
    expect(serializeSelection(state.doc, 1, 6)).toBe(`**${mentionSource}**`);
    assertMappingRoundTrip(state.doc);
  });
});

describe("literal fence regions", () => {
  it("keeps token sources literal in the opener and body while preserving atoms outside", () => {
    const source = `@README.md before\n\`\`\`ts $review\n@decorator ${citationSource}${contextSource}\n\`\`\`\n@AGENTS.md after`;
    const doc = makeDoc(source, { styling: true });
    expect(atoms(doc).map((node) => node.attrs.path)).toEqual(["README.md", "AGENTS.md"]);
    expect(serializeEditorDoc(doc).value).toBe(source);
    expect(doc.childCount).toBe(source.split("\n").length);
    assertMappingRoundTrip(doc);
  });

  it("keeps unclosed and nested tilde fences literal without building semantic nodes", () => {
    const source = "> - ~~~\n>   @README.md $review \n>   @AGENTS.md ";
    const doc = makeDoc(source, { styling: true });
    expect(atoms(doc)).toEqual([]);
    expect(serializeEditorDoc(doc).value).toBe(source);
    expect(doc.childCount).toBe(3);
    assertMappingRoundTrip(doc);
  });

  it.each([undefined, false, true])("keeps fences literal with styling %s", (styling) => {
    const source = "[outside.ts](outside.ts)\n```\n@README.md $review \n```";
    const doc = makeDoc(source, styling === undefined ? undefined : { styling });
    expect(atoms(doc).map((node) => node.attrs.source)).toEqual(["[outside.ts](outside.ts)"]);
    expect(serializeEditorDoc(doc).value).toBe(source);
    assertMappingRoundTrip(doc);
  });
});

describe("source and ProseMirror offset maps", () => {
  it("places source-requested edits inside literal fence token text at the requested character", () => {
    const source = "```\n[package.json](package.json) \n```";
    const doc = makeDoc(source, { styling: true });
    const map = serializeEditorDoc(doc);
    expect(atoms(doc)).toEqual([]);
    for (const cursor of [6, 15, 22, source.length]) {
      const state = EditorState.create({
        doc,
        selection: TextSelection.create(doc, flatToPm(map, expandedMarkdownToFlat(map, cursor))),
      });
      expect(serializeEditorDoc(state.apply(state.tr.insertText("X")).doc).value).toBe(
        source.slice(0, cursor) + "X" + source.slice(cursor),
      );
    }
  });

  it("clamps expanded source offsets inside actual atoms to their leading edges", () => {
    const source = `a${citationSource}${contextSource}\nb`;
    const map = serializeEditorDoc(makeDoc(source));
    const firstEnd = 1 + citationSource.length;
    const secondEnd = firstEnd + contextSource.length;
    expect(
      [0, 1, 2, firstEnd - 1, firstEnd, firstEnd + 1, secondEnd, secondEnd + 1, source.length].map(
        (offset) => expandedMarkdownToFlat(map, offset),
      ),
    ).toEqual([0, 1, 1, 1, 2, 2, 3, 4, 5]);
    expect(expandedMarkdownToFlat(map, -100)).toBe(0);
    expect(expandedMarkdownToFlat(map, source.length + 100)).toBe(5);
    assertMappingRoundTrip(makeDoc(source));
  });

  it("maps empty paragraphs and newlines onto real editable positions", () => {
    const doc = makeDoc("a\n\nb\n");
    const map = serializeEditorDoc(doc);
    const positions = [1, 2, 4, 6, 7, 9];
    expect(positions.map((_, offset) => flatToPm(map, offset))).toEqual(positions);
    expect(positions.map((position) => pmToFlat(map, position))).toEqual([0, 1, 2, 3, 4, 5]);
    expect([3, 5, 8].map((position) => pmToFlat(map, position))).toEqual([2, 3, 5]);
    expect(serializeSelection(doc, 2, 6)).toBe("\n\n");
    expect(serializeSelection(doc, 7, 9)).toBe("\n");
    assertMappingRoundTrip(doc);
  });

  it("preserves all selection slices across adjacent atoms and empty paragraphs", () => {
    const first = "[a.ts](a.ts)";
    const second = contextSource;
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("a"),
        schema.nodes["composer-mention"]!.create({ path: "a.ts", source: first }),
        schema.nodes["composer-context-reference"]!.create({
          kind: "terminal",
          contextId: "terminal_1",
          label: "Terminal lines",
          source: second,
        }),
        schema.text("b"),
      ]),
      schema.node("paragraph"),
      schema.node("paragraph", null, [schema.text("c")]),
    ]);
    doc.check();
    const source = `a${first}${second}b\n\nc`;
    const map = serializeEditorDoc(doc);
    const pmPositions = [1, 2, 3, 4, 5, 7, 9, 10];
    const expanded = [0, 1, 1 + first.length, 1 + first.length + second.length];
    expanded.push(...[2, 3, 4, 5].map((offset) => offset + first.length + second.length));
    expect(map.value).toBe(source);
    expect(pmPositions.map((_, offset) => flatToPm(map, offset))).toEqual(pmPositions);
    expect(expanded.map((_, offset) => flatToMarkdown(map, offset))).toEqual(expanded);
    for (let start = 0; start < pmPositions.length; start++) {
      for (let end = start; end < pmPositions.length; end++) {
        expect(serializeSelection(doc, pmPositions[start]!, pmPositions[end]!)).toBe(
          source.slice(expanded[start], expanded[end]),
        );
      }
    }
    assertMappingRoundTrip(doc);
  });

  it("clamps source offsets and ProseMirror positions to the actual document edges", () => {
    const doc = makeDoc("\n@README.md \n");
    const map = serializeEditorDoc(doc);
    expect(flatToPm(map, -1)).toBe(1);
    expect(flatToPm(map, 1000)).toBe(doc.content.size - 1);
    expect(pmToFlat(map, -1)).toBe(0);
    expect(pmToFlat(map, doc.content.size + 10)).toBe(map.docLength);
    expect(flatToMarkdown(map, -10)).toBe(0);
    expect(flatToMarkdown(map, 1000)).toBe(map.value.length);
  });
});
