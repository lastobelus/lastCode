import type { Definition, PhrasingContent } from "mdast";
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
import { markdownWithHtml, parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";
import { resolveMarkdownLinkPresentation } from "./markdownLinks";

function labelText(node: PhrasingContent): string {
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return "\n";
  return "children" in node ? node.children.map(labelText).join("") : "";
}

function hasImage(node: PhrasingContent): boolean {
  return (
    node.type === "image" ||
    node.type === "imageReference" ||
    ("children" in node && node.children.some(hasImage))
  );
}

function escapeLabel(value: string): string {
  return value.replace(/[\\`*_{}[\]<>&()]/g, "\\$&");
}

/** Preserve each authored file label before Enriched's URL-wide pill replacement runs. */
export function prepareEnrichedMarkdown(source: string) {
  let markdown = markdownWithHtml(source);
  const document = parseMarkdownDocument(markdown);
  const definitions = new Map<string, Definition>();
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
    else if ("children" in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(document);
  const authoredFileLinks = new Set<string>();
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "link" || node.type === "linkReference") {
      const destination = node.type === "link" ? node : definitions.get(node.identifier);
      if (!destination) return;
      const link = resolveMarkdownLinkPresentation(destination.url);
      if (link.kind !== "file") return;
      if (
        !node.children.some(hasImage) &&
        isMarkdownFileLinkLabel(node.children.map(labelText).join(""), destination.url)
      )
        return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const labelEnd = node.children.at(-1)?.position?.end.offset;
      if (start === undefined || end === undefined || labelEnd === undefined) return;
      authoredFileLinks.add(destination.url);
      const suffix = ` (${escapeLabel(link.label)})`;
      if (node.type === "link") {
        edits.push({ start: labelEnd, end: labelEnd, content: suffix });
      } else {
        // Shortcut and collapsed references cannot retain their identifier after a label edit.
        const href = destination.url
          .replace(/\\/g, "\\\\")
          .replace(/&/g, "\\&")
          .replace(/</g, "%3C")
          .replace(/>/g, "%3E")
          .replace(/\n/g, "%0A");
        const title = destination.title ? ` "${destination.title.replace(/[\\"]/g, "\\$&")}"` : "";
        edits.push({
          start,
          end,
          content: `[${markdown.slice(start + 1, labelEnd)}${suffix}](<${href}>${title})`,
        });
      }
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(document);
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return { markdown, authoredFileLinks };
}
