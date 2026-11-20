import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

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

async function renderLucideIconSvg(name: string, color: ProjectIconColor): Promise<string> {
  const [lucide, react, renderer] = await Promise.all([
    import("lucide-react"),
    import("react"),
    import("react-dom/server"),
  ]);
  // Resolve saved aliases as well as the current names.
  const exportName = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const exported: Record<string, unknown> = lucide;
  const glyph =
    Object.values(lucide.icons).find((component) => component === exported[exportName]) ??
    lucide.FolderCode;
  return renderer.renderToStaticMarkup(react.createElement(glyph, { color: colors[color] }));
}

export async function renderProjectIconSvg(icon: ProjectIconOverride): Promise<string> {
  switch (icon.kind) {
    case "emoji":
      return `${svg}<text x="12" y="18" text-anchor="middle" font-size="18" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${escapeText(icon.emoji)}</text></svg>`;
    case "monogram": {
      const color = colors[icon.color];
      const textLength = Array.from(monogramSegmenter.segment(icon.text)).length === 1 ? 9 : 18;
      return `${svg}<rect width="24" height="24" rx="6" fill="${color}" fill-opacity=".14"/><text x="12" y="16.2" text-anchor="middle" font-family="monospace" font-size="12" font-weight="700" textLength="${textLength}" lengthAdjust="spacingAndGlyphs" fill="${color}">${escapeText(icon.text)}</text></svg>`;
    }
    case "lucide":
      return renderLucideIconSvg(icon.name, icon.color);
  }
}
