#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a synchronous build-time generator.
// Builds the Lucide SVG table that `t3 project icon` renders saved glyph overrides from,
// so the server does not need React. The sidebar picker can save any icon in the catalog.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

type IconComponent = object;
type LucideModule = Record<string, unknown> & {
  readonly icons: Record<string, IconComponent>;
};
type ReactModule = {
  readonly createElement: (type: IconComponent, props: { readonly color: string }) => unknown;
};
type ReactDomServer = { readonly renderToStaticMarkup: (element: unknown) => string };

export type LucideProjectIconTable = {
  readonly lucideVersion: string;
  readonly aliases: Readonly<Record<string, string>>;
  readonly icons: Readonly<Record<string, { readonly class: string; readonly body: string }>>;
};

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
export const LUCIDE_PROJECT_ICON_TABLE_PATH = NodePath.join(
  repositoryRoot,
  "apps/server/src/assets/lucideProjectIcons.generated.json",
);
const COLOR_PLACEHOLDER = "#123456";
const SVG_PATTERN =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#123456" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="([^"]+)" aria-hidden="true">(.*)<\/svg>$/s;

export function buildLucideProjectIconTable(): LucideProjectIconTable {
  const require = NodeModule.createRequire(NodePath.join(repositoryRoot, "apps/web/package.json"));
  const lucide = require("lucide-react") as LucideModule;
  const react = require("react") as ReactModule;
  const server = require("react-dom/server") as ReactDomServer;
  const lucideVersion = (require("lucide-react/package.json") as { version: string }).version;

  const canonical = new Map(Object.entries(lucide.icons).map(([name, icon]) => [icon, name]));
  const icons: Record<string, { class: string; body: string }> = {};
  for (const [name, icon] of Object.entries(lucide.icons)) {
    const svg = server.renderToStaticMarkup(
      react.createElement(icon, { color: COLOR_PLACEHOLDER }),
    );
    const match = SVG_PATTERN.exec(svg);
    if (!match) throw new Error(`Lucide ${name} no longer renders the expected <svg> wrapper.`);
    icons[name] = { class: match[1]!, body: match[2]! };
  }

  // The server resolves `X`, `XIcon` and `LucideX` by stripping one affix, as Lucide exports them.
  const aliases: Record<string, string> = {};
  const exported = new Set<string>();
  for (const [exportName, value] of Object.entries(lucide)) {
    const target = canonical.get(value as IconComponent);
    if (target === undefined) continue;
    exported.add(exportName);
    if (exportName.endsWith("Icon") || exportName.startsWith("Lucide")) continue;
    if (exportName !== target) aliases[exportName] = target;
  }
  const expected = [...Object.keys(icons), ...Object.keys(aliases)].flatMap((name) => [
    name,
    `${name}Icon`,
    `Lucide${name}`,
  ]);
  if (expected.length !== exported.size || expected.some((name) => !exported.has(name))) {
    throw new Error("Lucide icon exports no longer follow the X, XIcon, LucideX naming.");
  }

  return { lucideVersion, aliases, icons };
}

export const formatLucideProjectIconTable = (table: LucideProjectIconTable) =>
  `${JSON.stringify(table, null, 2)}\n`;

if (import.meta.main) {
  const expected = formatLucideProjectIconTable(buildLucideProjectIconTable());
  if (process.argv.includes("--check")) {
    const current = NodeFS.existsSync(LUCIDE_PROJECT_ICON_TABLE_PATH)
      ? NodeFS.readFileSync(LUCIDE_PROJECT_ICON_TABLE_PATH, "utf8")
      : "";
    if (current !== expected) {
      console.error(
        "The Lucide project icon table is stale. Run: node scripts/lastcode-lucide-project-icons.ts",
      );
      process.exit(1);
    }
  } else {
    NodeFS.writeFileSync(LUCIDE_PROJECT_ICON_TABLE_PATH, expected);
  }
}
