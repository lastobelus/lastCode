import {
  normalizeMarkdownLinkDestination,
  splitMarkdownLinkSearchAndHash,
} from "./markdownLinks.ts";

export { classifyMarkdownImageSource, type MarkdownImageSource } from "./markdownLinks.ts";

export function markdownImageSourceFragment(source: string): string {
  return splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(source)).hash;
}
