import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";

/** Clipboard HTML and external drops must obey the same paragraph-per-line source model. */
export function normalizeComposerSourceSlice(slice: Slice, schema: Schema): Slice {
  let needsNormalization = false;
  slice.content.descendants((node) => {
    if (node.type.name === "hardBreak" || (node.isText && node.text?.includes("\n"))) {
      needsNormalization = true;
    }
  });
  if (!needsNormalization) return slice;

  const paragraphs: ProseMirrorNode[] = [];
  let line: ProseMirrorNode[] = [];
  const finishLine = () => {
    paragraphs.push(schema.nodes.paragraph!.create(null, line));
    line = [];
  };
  const append = (node: ProseMirrorNode) => {
    if (node.type.name === "hardBreak") {
      finishLine();
    } else if (node.isText && node.text?.includes("\n")) {
      node.text.split("\n").forEach((text, index) => {
        if (index > 0) finishLine();
        if (text) line.push(schema.text(text, node.marks));
      });
    } else {
      line.push(node);
    }
  };
  slice.content.forEach((node, _offset, index) => {
    if (index > 0 && node.isBlock) finishLine();
    if (node.isTextblock) node.forEach(append);
    else append(node);
  });
  finishLine();
  const inline = slice.content.firstChild?.isInline;
  return new Slice(
    Fragment.fromArray(paragraphs),
    inline ? 1 : Math.min(slice.openStart, 1),
    inline ? 1 : Math.min(slice.openEnd, 1),
  );
}
