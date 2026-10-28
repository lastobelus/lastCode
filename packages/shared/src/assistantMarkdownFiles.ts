import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { CHAT_MARKDOWN_REMARK_PLUGINS, CHAT_MARKDOWN_REHYPE_PLUGINS } from "./markdownPipeline.ts";
import { isAbsolutePath } from "./path.ts";
import { classifyMarkdownImageSource } from "./markdownImages.ts";
import { inlineCodeFilePathCandidate, parseMarkdownFileLink } from "./markdownLinks.ts";

const publishedMarkdown = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
  .freeze();

/** Files rendered as clickable links, code chips, citations, or media in an assistant message. */
export function assistantMarkdownFileReferences(
  markdown: string,
  cwd: string,
): ReadonlyArray<{ readonly path: string; readonly bareFilename: boolean }> {
  const paths: Array<{ readonly path: string; readonly bareFilename: boolean }> = [];
  interface MarkdownNode {
    readonly type: string;
    readonly tagName?: string;
    readonly value?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly children?: ReadonlyArray<MarkdownNode>;
  }
  const addDestination = (destination: string, image: boolean) => {
    if (image) {
      const source = classifyMarkdownImageSource(destination, cwd);
      if (source._tag === "WorkspaceFile") paths.push({ path: source.path, bareFilename: false });
    } else {
      const target = parseMarkdownFileLink(destination);
      if (target !== null)
        paths.push({
          path: target.path,
          bareFilename:
            !isAbsolutePath(target.path) &&
            !/[\\/]/.test(target.path) &&
            target.path !== "." &&
            target.path !== "..",
        });
    }
  };
  const textContent = (node: MarkdownNode): string =>
    node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textContent).join("");
  const visit = (node: MarkdownNode, insideLink: boolean): void => {
    const href = node.properties?.href;
    if (node.tagName === "a" && typeof href === "string") addDestination(href, false);
    if (node.tagName === "img") {
      const localSrc = node.properties?.dataLocalSrc;
      const src =
        typeof localSrc === "string" ? localSrc.replaceAll("\\", "/") : node.properties?.src;
      if (typeof src === "string") addDestination(src, true);
    }
    if (node.tagName === "code" && node.properties?.dataInlineCode != null && !insideLink) {
      const candidate = inlineCodeFilePathCandidate(textContent(node));
      if (candidate !== null) addDestination(candidate, false);
    }
    for (const child of node.children ?? []) visit(child, insideLink || node.tagName === "a");
  };
  // Authorize only the destinations surviving the same HTML parsing and
  // sanitization as chat, including references, directives, and raw HTML.
  visit(publishedMarkdown.runSync(publishedMarkdown.parse(markdown), { value: markdown }), false);
  return paths;
}
