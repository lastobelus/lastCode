// @effect-diagnostics nodeBuiltinImport:off - compares generated files with Lucide loaded from apps/web.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  buildLucideProjectIconTable,
  formatLucideProjectIconTable,
  LUCIDE_PROJECT_ICON_TABLE_PATH,
} from "./lastcode-lucide-project-icons.ts";

const webRequire = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../apps/web/package.json"),
);
const { createElement } = webRequire("react") as {
  createElement: (type: unknown, props: { color: string }) => unknown;
};
const { renderToStaticMarkup } = webRequire("react-dom/server") as {
  renderToStaticMarkup: (element: unknown) => string;
};

// App modules load at runtime: the scripts typecheck cannot follow web's extensionless imports.
const appModule = <T>(path: string) =>
  import(NodePath.resolve(import.meta.dirname, path)) as Promise<T>;
const { renderProjectIconSvg } = await appModule<{
  renderProjectIconSvg: (icon: { kind: "lucide"; name: string; color: "blue" }) => string;
}>("../apps/server/src/assets/projectIconSvg.ts");
const { lucideIconByName, lucideIconNames } = await appModule<{
  lucideIconByName: (name: string) => unknown;
  lucideIconNames: ReadonlyArray<string>;
}>("../apps/web/src/lib/lucideIconByName.ts");
const { filterProjectIconNames } = await appModule<{
  filterProjectIconNames: (query: string) => ReadonlyArray<string>;
}>("../apps/web/src/projectIconOptions.ts");

describe("Lucide project icon table", () => {
  it("matches the Lucide catalog the web app pins", () => {
    expect(
      NodeFS.readFileSync(LUCIDE_PROJECT_ICON_TABLE_PATH, "utf8"),
      "Run: node scripts/lastcode-lucide-project-icons.ts",
    ).toBe(formatLucideProjectIconTable(buildLucideProjectIconTable()));
  });

  it("renders every icon name the sidebar can save as the sidebar does", () => {
    const saveable = new Set([...filterProjectIconNames(""), ...lucideIconNames]);
    for (const name of saveable) {
      const icon = lucideIconByName(name);
      expect(icon, name).toBeDefined();
      expect(renderProjectIconSvg({ kind: "lucide", name, color: "blue" }), name).toBe(
        renderToStaticMarkup(createElement(icon, { color: "#2563eb" })),
      );
    }
  });
});
