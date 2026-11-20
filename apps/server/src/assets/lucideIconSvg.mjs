export async function renderLucideIconSvg(name, color) {
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
  const glyph =
    Object.values(lucide.icons).find((component) => component === lucide[exportName]) ??
    lucide.FolderCode;
  return renderer.renderToStaticMarkup(react.createElement(glyph, { color }));
}
