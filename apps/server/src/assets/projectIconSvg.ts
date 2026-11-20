import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import lucide from "./lucideProjectIcons.generated.json" with { type: "json" };

const colors: Record<ProjectIconColor, string> = {
  gray: "#4b5563",
  red: "#dc2626",
  orange: "#ea580c",
  amber: "#d97706",
  yellow: "#ca8a04",
  lime: "#65a30d",
  green: "#16a34a",
  emerald: "#059669",
  teal: "#0d9488",
  cyan: "#0891b2",
  sky: "#0284c7",
  blue: "#2563eb",
  indigo: "#4f46e5",
  violet: "#7c3aed",
  purple: "#9333ea",
  fuchsia: "#c026d3",
  pink: "#db2777",
  rose: "#e11d48",
};

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">';

const escapeText = (text: string) =>
  text
    .toWellFormed()
    .replace(/[\p{Cc}\uFFFE\uFFFF]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// Resolves names the way the web's lucideIconByName does: any Lucide export, aliases included.
const lucideIcon = (name: string) => {
  const exportName = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const icons: Readonly<Record<string, { readonly class: string; readonly body: string }>> =
    lucide.icons;
  const aliases: Readonly<Record<string, string>> = lucide.aliases;
  const key = [exportName, exportName.replace(/^Lucide/, ""), exportName.replace(/Icon$/, "")]
    .map((candidate) => (Object.hasOwn(aliases, candidate) ? aliases[candidate]! : candidate))
    .find((candidate) => Object.hasOwn(icons, candidate));
  return icons[key ?? "FolderCode"]!;
};

export function renderProjectIconSvg(icon: ProjectIconOverride): string {
  switch (icon.kind) {
    case "emoji":
      return `${svg}<text x="12" y="18" text-anchor="middle" font-size="18" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${escapeText(icon.emoji)}</text></svg>`;
    case "monogram": {
      const color = colors[icon.color];
      const textLength = Array.from(monogramSegmenter.segment(icon.text)).length === 1 ? 9 : 18;
      return `${svg}<rect width="24" height="24" rx="6" fill="${color}" fill-opacity=".14"/><text x="12" y="16.2" text-anchor="middle" font-family="monospace" font-size="12" font-weight="700" textLength="${textLength}" lengthAdjust="spacingAndGlyphs" fill="${color}">${escapeText(icon.text)}</text></svg>`;
    }
    case "lucide": {
      const glyph = lucideIcon(icon.name);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${colors[icon.color]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${glyph.class}" aria-hidden="true">${glyph.body}</svg>`;
    }
  }
}
