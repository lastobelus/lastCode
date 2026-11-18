import { getSchema, Node } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import { normalizeComposerSourceSlice } from "./lastcodeComposerSourceSlice";
import { serializeEditorDoc } from "./composer-rich-text-doc";

const mention = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes: () => ({ source: { default: "" } }),
});
const schema = getSchema([StarterKit, mention]);

describe("source paragraph clipboard/drop normalization", () => {
  it("splits HTML parser newline text into source paragraphs without losing blank lines", () => {
    const paragraph = schema.nodes.paragraph!.create(null, schema.text("a\n\nb\n"));
    const result = normalizeComposerSourceSlice(new Slice(Fragment.from(paragraph), 1, 1), schema);
    const doc = schema.nodes.doc!.create(null, result.content);
    expect(serializeEditorDoc(doc).value).toBe("a\n\nb\n");
    expect(doc.childCount).toBe(4);
    expect(result.openStart).toBe(1);
    expect(result.openEnd).toBe(1);
    expect(
      doc.content.content.every((paragraph) =>
        paragraph.content.content.every((node) => node.type.name !== "hardBreak"),
      ),
    ).toBe(true);
  });

  it("normalizes a parsed HTML hard break while retaining actual atom nodes", () => {
    const htmlSchema = getSchema([StarterKit, mention]);
    const chip = htmlSchema.nodes["composer-mention"]!.create({ source: "[file](file)" });
    const paragraph = htmlSchema.nodes.paragraph!.create(null, [
      htmlSchema.text("a"),
      htmlSchema.nodes.hardBreak!.create(),
      chip,
      htmlSchema.text("b"),
    ]);
    const result = normalizeComposerSourceSlice(
      new Slice(Fragment.from(paragraph), 1, 1),
      htmlSchema,
    );
    const doc = htmlSchema.nodes.doc!.create(null, result.content);
    expect(serializeEditorDoc(doc).value).toBe("a\n[file](file)b");
    expect(doc.child(1).firstChild).toBe(chip);
  });

  it("keeps existing paragraph boundaries and closed slice edges", () => {
    const content = Fragment.fromArray([
      schema.nodes.paragraph!.create(null, schema.text("a\nb")),
      schema.nodes.paragraph!.create(null, schema.text("c")),
    ]);
    const result = normalizeComposerSourceSlice(new Slice(content, 0, 0), schema);
    expect(serializeEditorDoc(schema.nodes.doc!.create(null, result.content)).value).toBe(
      "a\nb\nc",
    );
    expect(result.openStart).toBe(0);
    expect(result.openEnd).toBe(0);
  });

  it("preserves an ordinary source slice and its atom identity", () => {
    const chip = schema.nodes["composer-mention"]!.create({ source: "[file](file)" });
    const slice = new Slice(Fragment.from(schema.nodes.paragraph!.create(null, [chip])), 1, 1);
    expect(normalizeComposerSourceSlice(slice, schema)).toBe(slice);
  });
});
