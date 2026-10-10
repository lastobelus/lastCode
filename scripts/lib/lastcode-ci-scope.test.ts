// @effect-diagnostics nodeBuiltinImport:off - Fixtures exercise Git's commit and rename behavior.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveQuickCiConfigReference, resolveQuickCiScope } from "./lastcode-ci-scope.ts";

const repositories: Array<string> = [];

afterEach(() => {
  for (const repo of repositories.splice(0)) NodeFS.rmSync(repo, { recursive: true, force: true });
});

function git(repo: string, args: ReadonlyArray<string>): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(repo: string, file: string, contents: string): void {
  const path = NodePath.join(repo, file);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
}

function workspace(
  directory: string,
  name: string,
  options: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly typecheck?: boolean;
    readonly config?: Record<string, unknown>;
  } = {},
): Record<string, string> {
  return {
    [`${directory}/package.json`]: JSON.stringify({
      name,
      type: "module",
      scripts: options.typecheck === false ? {} : { typecheck: "tsc --noEmit" },
      dependencies: options.dependencies ?? {},
    }),
    [`${directory}/tsconfig.json`]: JSON.stringify(
      options.config ?? {
        extends: `${directory
          .split("/")
          .map(() => "..")
          .join("/")}/tsconfig.base.json`,
        include: ["src"],
      },
    ),
    [`${directory}/src/index.ts`]: "export const value = 1;\n",
  };
}

function fixture(files: Readonly<Record<string, string>> = {}) {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-scope-"));
  repositories.push(repo);
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.name", "CI Fixture"]);
  git(repo, ["config", "user.email", "ci@fixture.invalid"]);
  git(repo, ["config", "core.hooksPath", "/dev/null"]);
  const initial = {
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - apps/*\n  - scripts\n",
    "package.json": JSON.stringify({ name: "fixture", private: true }),
    "tsconfig.base.json":
      '{\n // Shared options, without an inherited include.\n "compilerOptions": { "strict": true, },\n}\n',
    ...workspace("packages/library", "@fixture/library"),
    ...workspace("apps/consumer", "@fixture/consumer", {
      dependencies: { "@fixture/library": "workspace:*" },
    }),
    ...workspace("apps/unrelated", "@fixture/unrelated"),
    "apps/consumer/src/index.ts":
      'import { value } from "@fixture/library";\nexport const consumer: number = value;\n',
    ...files,
  };
  for (const [file, contents] of Object.entries(initial)) write(repo, file, contents);
  const commit = () => {
    git(repo, ["add", "--all"]);
    git(repo, ["commit", "--quiet", "-m", "fixture"]);
    return git(repo, ["rev-parse", "HEAD"]);
  };
  const base = commit();
  return {
    repo,
    base,
    commit,
    change: (file: string, contents: string) => write(repo, file, contents),
    scope: () => resolveQuickCiScope(repo, base, commit()),
  };
}

describe("resolveQuickCiScope", () => {
  it("resolves relative installed config references using Windows path separators", () => {
    expect(
      resolveQuickCiConfigReference(
        "C:\\workspace\\node_modules\\astro\\tsconfigs\\strict.json",
        "./base.json",
      ),
    ).toBe("C:\\workspace\\node_modules\\astro\\tsconfigs\\base.json");
    expect(
      resolveQuickCiConfigReference("apps/web/tsconfig.json", "../../tsconfig.base.json"),
    ).toBe("tsconfig.base.json");
    expect(
      resolveQuickCiConfigReference(
        "/workspace/node_modules/astro/tsconfigs/strict.json",
        "./base.json",
      ),
    ).toBe("/workspace/node_modules/astro/tsconfigs/base.json");
  });

  it.each([
    ["single quotes", "packages:\n  - 'packages/*'\n  - 'apps/*'"],
    ["double quotes", 'packages:\n  - "packages/*"\n  - "apps/*"'],
    [
      "unquoted and inline comments",
      "packages: # list\n  - packages/*# libraries\n  - apps/* # applications",
    ],
    [
      "blank/comment lines and CRLF",
      "packages:\r\n\r\n# comment\r\n  # comment\r\n  - packages/*\r\n  - apps/*\r\n",
    ],
    ["section boundary", "packages:\n  - packages/*\n  - apps/*\ncatalog:\n  unsupported: ignored"],
    [
      "first exact header",
      " packages:\nignored: value\npackages:\n  - packages/*\n  - apps/*\npackages:\n  unsupported",
    ],
    ["duplicates and source order", "packages:\n  - apps/*\n  - packages/*\n  - apps/*"],
  ])("narrows scope with supported workspace lists: %s", (_name, text) => {
    const repo = fixture({ "pnpm-workspace.yaml": text });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toEqual({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
      reason: "Changed workspaces and their source/configuration consumers",
      changedFiles: ["packages/library/src/index.ts"],
    });
  });

  it.each([
    [
      "indented header",
      " packages:\n  - packages/*",
      "Unsupported or missing workspace package list",
    ],
    ["inline list", "packages: [packages/*]", "Unsupported or missing workspace package list"],
    ["empty list", "packages:", "Workspace package list is empty"],
    [
      "comments before section",
      "packages:\n # comment\n\nother:\n  - apps/*",
      "Workspace package list is empty",
    ],
    [
      "unindented entry terminates section",
      "packages:\n- packages/*",
      "Workspace package list is empty",
    ],
    ["missing dash", "packages:\n  packages/*", "Unsupported workspace package pattern"],
    ["empty entry", "packages:\n  - ", "Unsupported workspace package pattern"],
    [
      "unsupported trailing text",
      "packages:\n  - 'packages/*' extra",
      "Unsupported workspace package pattern",
    ],
    [
      "unsupported glob",
      "packages:\n  - 'packages/[ab]'",
      "Unsupported scope pattern packages/[ab]",
    ],
    [
      "validation precedes later extraction",
      "packages:\n  - 'packages/[ab]'\n  malformed",
      "Unsupported scope pattern packages/[ab]",
    ],
    [
      "extraction precedes later validation",
      "packages:\n  malformed\n  - 'packages/[ab]'",
      "Unsupported workspace package pattern",
    ],
  ])("preserves full-CI diagnostics for workspace lists: %s", (_name, text, error) => {
    const repo = fixture({ "pnpm-workspace.yaml": text });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toEqual({
      kind: "full",
      packages: [],
      reason: `Cannot safely narrow typecheck: ${error}`,
      changedFiles: ["packages/library/src/index.ts"],
    });
  });

  it("covers the unchanged consumer when a public library type becomes incompatible", () => {
    const repo = fixture();
    repo.change("packages/library/src/index.ts", 'export const value = "no longer a number";\n');
    expect(repo.scope()).toEqual({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
      reason: expect.any(String),
      changedFiles: ["packages/library/src/index.ts"],
    });
  });

  it("keeps an unrelated leaf change limited to its whole workspace", () => {
    const repo = fixture();
    repo.change("apps/unrelated/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().packages).toEqual(["@fixture/unrelated"]);
  });

  it("follows reverse dependencies through a workspace without a typecheck script", () => {
    const repo = fixture({
      ...workspace("packages/middle", "@fixture/middle", {
        dependencies: { "@fixture/library": "workspace:*" },
        typecheck: false,
      }),
      ...workspace("apps/consumer", "@fixture/consumer", {
        dependencies: { "@fixture/middle": "workspace:*" },
      }),
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().packages).toEqual(["@fixture/consumer", "@fixture/library"]);
  });

  it("finds undeclared bare, relative, and escaped module imports", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts":
        "/* don't hide the import */ export type { Value } from '@fixture/\\u006cibrary';\n",
      "apps/unrelated/src/index.ts":
        "export { value } from '../../../packages/library/src/index.js';\n",
    });
    repo.change(
      "packages/library/src/index.ts",
      "export const value = 2;\nexport type Value = number;\n",
    );
    expect(repo.scope().packages).toEqual([
      "@fixture/consumer",
      "@fixture/library",
      "@fixture/unrelated",
    ]);
  });

  it("does not turn unused package names or generated import text into dependencies", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts":
        'export const label = "@fixture/library";\nexport const output = `export { value } from "@fixture/library"`;\nexport const template = `output ${label} export * as library from "@fixture/library"`;\nexport const path = "../../../packages/library/src/index.js";\n// import { value } from "@fixture/library";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({ kind: "affected", packages: ["@fixture/library"] });
  });

  it.each([
    'import /* comment */ {\n value\n} /* comment */ from\n "@fixture/library";\nexport { value };\n',
    'export * as library from "@fixture/library";\n',
    'export type * as library from "@fixture/library";\n',
    'import library = require("@fixture/library");\nexport { library };\n',
    'export const load = import("@fixture/library");\n',
    'export type Value = import("@fixture/library").Value;\n',
    'export const library = require("@fixture/library");\n',
    '/// <reference types="@fixture/library" />\nexport const value = 1;\n',
  ])("finds actual import and declaration syntax: %s", (source) => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts": source,
    });
    repo.change(
      "packages/library/src/index.ts",
      "export const value = 2;\nexport type Value = number;\n",
    );
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("resolves declaration reference paths without ./ relative to their containing file", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts": 'export { value } from "../../../support/root.js";\n',
      "support/root.ts": '/// <reference path="types.d.ts" />\nexport const value = 1;\n',
      "support/types.d.ts": 'export type Value = import("@fixture/library").Value;\n',
    });
    repo.change(
      "packages/library/src/index.ts",
      "export const value = 2;\nexport type Value = number;\n",
    );
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("adds the server and desktop cross-workspace includes for shared script helpers", () => {
    const config = { extends: "../../tsconfig.base.json", include: ["src", "../../scripts/lib"] };
    const repo = fixture({
      ...workspace("scripts", "@fixture/scripts", {
        config: { extends: "../tsconfig.base.json", include: ["**/*.ts"] },
      }),
      ...workspace("apps/server", "@fixture/server", { config }),
      ...workspace("apps/desktop", "@fixture/desktop", { config }),
      ...workspace("apps/web", "@fixture/web", {
        config: {
          extends: "../../tsconfig.base.json",
          include: ["src", "../../scripts/lib/public.ts"],
        },
      }),
      "scripts/lib/private.ts": "export const helper = 1;\n",
      "scripts/lib/public.ts": "export const helper = 1;\n",
    });
    repo.change("scripts/lib/private.ts", "export const helper = 2;\n");
    expect(repo.scope().packages).toEqual([
      "@fixture/desktop",
      "@fixture/scripts",
      "@fixture/server",
    ]);
  });

  it("propagates a library dependency imported from a cross-included script helper", () => {
    const config = { extends: "../../tsconfig.base.json", include: ["src", "../../scripts/lib"] };
    const repo = fixture({
      ...workspace("scripts", "@fixture/scripts", {
        config: { extends: "../tsconfig.base.json", include: ["**/*.ts"] },
      }),
      ...workspace("apps/server", "@fixture/server", { config }),
      ...workspace("apps/desktop", "@fixture/desktop", { config }),
      "scripts/lib/helper.ts":
        'import type { Value } from "@fixture/library";\nexport type Helper = Value;\n',
    });
    repo.change(
      "packages/library/src/index.ts",
      "export const value = 2;\nexport type Value = number;\n",
    );
    expect(repo.scope().packages).toEqual([
      "@fixture/consumer",
      "@fixture/desktop",
      "@fixture/library",
      "@fixture/scripts",
      "@fixture/server",
    ]);
  });

  it("accounts for paths aliases even when the dependency is undeclared", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer", {
        config: {
          extends: "../../tsconfig.base.json",
          compilerOptions: { paths: { "library/*": ["../../packages/library/src/*"] } },
          include: ["src"],
        },
      }),
      "apps/consumer/src/index.ts": 'export { value } from "library/index";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().packages).toEqual(["@fixture/consumer", "@fixture/library"]);
  });

  it("accounts for baseUrl resolution and project references", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer", {
        config: {
          extends: "../../tsconfig.base.json",
          compilerOptions: { baseUrl: "../.." },
          include: ["src"],
        },
      }),
      "apps/consumer/src/index.ts": 'export { value } from "packages/library/src/index";\n',
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: {
          extends: "../../tsconfig.base.json",
          include: ["src"],
          references: [{ path: "../../packages/library" }],
        },
      }),
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().packages).toEqual([
      "@fixture/consumer",
      "@fixture/library",
      "@fixture/unrelated",
    ]);
  });

  it("accounts for package import maps and local dependency aliases", () => {
    const repo = fixture({
      "apps/consumer/package.json": JSON.stringify({
        name: "@fixture/consumer",
        scripts: { typecheck: "tsc --noEmit" },
        imports: { "#library": "@fixture/library" },
      }),
      "apps/consumer/src/index.ts": 'export { value } from "#library";\n',
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        dependencies: { "library-alias": "link:../../packages/library" },
      }),
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().packages).toEqual([
      "@fixture/consumer",
      "@fixture/library",
      "@fixture/unrelated",
    ]);
  });

  it.each([
    "@fixture/library/subpath",
    "../../packages/library/src/../src/index.ts",
    { "#condition": { browser: [null, 42, false, "missing", "@fixture/library"] } },
    ["@fixture/library", "@fixture/library", "@fixture/consumer", "./src/index.ts"],
  ])("includes manifest-import consumers and their indirect dependents for %j", (imports) => {
    const repo = fixture({
      "apps/consumer/package.json": JSON.stringify({
        name: "@fixture/consumer",
        scripts: { typecheck: "tsc --noEmit" },
        imports,
      }),
      "apps/consumer/src/index.ts": "export const consumer = 1;\n",
      ...workspace("apps/indirect", "@fixture/indirect", {
        dependencies: { "@fixture/consumer": "workspace:*" },
      }),
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/indirect", "@fixture/library"],
    });
  });

  it.each([null, 42, false, [null, false, 42], { unknown: ["missing", "../../outside"] }])(
    "ignores unresolved and non-string manifest-import values %j",
    (imports) => {
      const repo = fixture({
        "apps/consumer/package.json": JSON.stringify({
          name: "@fixture/consumer",
          scripts: { typecheck: "tsc --noEmit" },
          imports,
        }),
        "apps/consumer/src/index.ts": "export const consumer = 1;\n",
      });
      repo.change("packages/library/src/index.ts", "export const value = 2;\n");
      expect(repo.scope()).toMatchObject({ kind: "affected", packages: ["@fixture/library"] });
    },
  );

  it.each([true, false])(
    "preserves first registered overlapping import name (short first: %j)",
    (shortFirst) => {
      const first = shortFirst ? "@fixture/overlap" : "@fixture/overlap/child";
      const second = shortFirst ? "@fixture/overlap/child" : "@fixture/overlap";
      const repo = fixture({
        ...workspace("packages/a-first-longer", first),
        ...workspace("packages/z-second", second),
        "apps/consumer/package.json": JSON.stringify({
          name: "@fixture/consumer",
          scripts: { typecheck: "tsc --noEmit" },
          imports: { "#overlap": "@fixture/overlap/child" },
        }),
        "apps/consumer/src/index.ts": "export const consumer = 1;\n",
      });
      repo.change("packages/z-second/src/index.ts", "export const value = 2;\n");
      expect(repo.scope()).toMatchObject({ kind: "affected", packages: [second] });
      repo.change("packages/a-first-longer/src/index.ts", "export const value = 2;\n");
      expect(repo.scope()).toMatchObject({
        kind: "affected",
        packages: ["@fixture/consumer", first, second].sort(),
      });
    },
  );

  it("resolves import-map alias names using their registered owner", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        dependencies: { "library-alias": "link:../../packages/library" },
      }),
      "apps/consumer/package.json": JSON.stringify({
        name: "@fixture/consumer",
        scripts: { typecheck: "tsc --noEmit" },
        imports: { "#alias": "library-alias/subpath" },
      }),
      "apps/consumer/src/index.ts": "export const consumer = 1;\n",
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().packages).toEqual([
      "@fixture/consumer",
      "@fixture/library",
      "@fixture/unrelated",
    ]);
  });

  it("owns nested file modules through their containing workspace and finds their undeclared consumers", () => {
    const repo = fixture({
      ...workspace("apps/mobile", "@fixture/mobile", {
        dependencies: { "@fixture/native-module": "file:./modules/native" },
      }),
      "apps/mobile/modules/native/package.json": JSON.stringify({
        name: "@fixture/native-module",
        exports: "./src/index.ts",
      }),
      "apps/mobile/modules/native/src/index.ts": "export const native = 1;\n",
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts": 'export { native } from "@fixture/native-module";\n',
    });
    repo.change("apps/mobile/modules/native/src/index.ts", "export const native = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/mobile"],
    });
  });

  it("retains the full fallback for a local dependency outside every workspace", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        dependencies: { "unowned-module": "file:../../support/module" },
      }),
      "support/module/package.json": JSON.stringify({ name: "unowned-module" }),
    });
    repo.change("apps/unrelated/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "full",
      reason: expect.stringContaining("Unresolved local dependency"),
    });
  });

  it("preserves both rename paths and the consumers of a deleted source file", () => {
    const repo = fixture();
    git(repo.repo, ["mv", "packages/library/src/index.ts", "apps/unrelated/src/moved.ts"]);
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library", "@fixture/unrelated"],
      changedFiles: ["apps/unrelated/src/moved.ts", "packages/library/src/index.ts"],
    });
  });

  it("preserves unusual paths across additions, modifications, deletions and renames", () => {
    const removed = "docs/removed\npage.md";
    const modified = "docs/modified\tpage.md";
    const original = "packages/library/src/café source.ts";
    const destination = "apps/unrelated/src/moved\t文.ts";
    const added = "docs/added space 文.md";
    const repo = fixture({
      [removed]: "Remove this page.\n",
      [modified]: "Original page.\n",
      [original]: "export const renamed = true;\n",
    });
    NodeFS.unlinkSync(NodePath.join(repo.repo, removed));
    repo.change(modified, "Updated page.\n");
    repo.change(added, "New page.\n");
    git(repo.repo, ["mv", original, destination]);
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library", "@fixture/unrelated"],
      changedFiles: [destination, added, modified, removed, original].sort(),
    });
  });

  it("throws native Git resolution errors rather than returning a full scope", () => {
    const repo = fixture();
    expect(() => resolveQuickCiScope(repo.repo, repo.base, "missing-fixture-revision")).toThrow(
      "Cannot resolve Quick CI scope:",
    );
  });

  it("checks the source side when a code file is renamed to documentation", () => {
    const repo = fixture();
    NodeFS.mkdirSync(NodePath.join(repo.repo, "docs"));
    git(repo.repo, ["mv", "packages/library/src/index.ts", "docs/index.md"]);
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("checks a deleted source file using its committed path", () => {
    const repo = fixture();
    NodeFS.unlinkSync(NodePath.join(repo.repo, "packages/library/src/index.ts"));
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
      changedFiles: ["packages/library/src/index.ts"],
    });
  });

  it("skips typechecks for a documentation-only commit", () => {
    const repo = fixture();
    repo.change("docs/user/setup.md", "Updated setup instructions.\n");
    repo.change("packages/library/README.md", "Library documentation.\n");
    expect(repo.scope()).toMatchObject({ kind: "none", packages: [] });
  });

  it.each([
    "docs/guide.MD",
    ".agents/guide.rst",
    ".github/ISSUE_TEMPLATE/bug.txt",
    "packages/library/readme.notes.MD",
    "AGENTS",
    "license.notice.txt",
    "CHANGELOG.release.notes",
    "DOCS/icon.SVG",
    "nested/Public/font.WOFF2",
    "assets/sound.mp3",
    "resources/icon.ico",
  ])("skips the conservative documentation/asset allowlist: %s", (file) => {
    const repo = fixture();
    repo.change(file, "Updated inert contents.\n");
    expect(repo.scope()).toMatchObject({ kind: "none", packages: [], changedFiles: [file] });
  });

  it.each([
    "DOCS/guide.md",
    ".github/issue_template/bug.txt",
    "nested/LICENSE.txt",
    "nested/AGENTS",
    "notdocs/guide.md",
    "docs-extra/guide.md",
    "docs/guide.md.ts",
    "README",
    "README.md.js",
    "public/settings.json",
    "assets/worker.js",
    "resources/options.yaml",
    "unowned/logo.svg",
  ])("keeps unrecognized or executable paths on the full fallback: %s", (file) => {
    const repo = fixture();
    repo.change(file, "Updated contents.\n");
    expect(repo.scope()).toMatchObject({
      kind: "full",
      packages: ["@fixture/consumer", "@fixture/library", "@fixture/unrelated"],
      changedFiles: [file],
    });
  });

  it("does not read an oversized unrelated vendored source for a documentation change", () => {
    const repo = fixture();
    const vendorFile = ".repos/reference/bundle.js";
    write(repo.repo, vendorFile, "// read-only reference\n");
    NodeFS.truncateSync(NodePath.join(repo.repo, vendorFile), 129 * 1024 * 1024);
    const base = repo.commit();
    repo.change("docs/user/setup.md", "Updated setup instructions.\n");
    expect(resolveQuickCiScope(repo.repo, base, repo.commit())).toMatchObject({
      kind: "none",
      packages: [],
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(resolveQuickCiScope(repo.repo, base, repo.commit())).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
    git(repo.repo, ["mv", vendorFile, "packages/library/src/oversized.js"]);
    const oversizedBase = repo.commit();
    repo.change("packages/library/src/index.ts", "export const value = 3;\n");
    expect(resolveQuickCiScope(repo.repo, oversizedBase, repo.commit())).toMatchObject({
      kind: "full",
      reason: expect.stringContaining("snapshot budget"),
    });
  });

  it("skips reading even workspace source bodies for inert changes after config validation", () => {
    const repo = fixture();
    write(repo.repo, "packages/library/src/large.js", "// oversized tracked source\n");
    NodeFS.truncateSync(NodePath.join(repo.repo, "packages/library/src/large.js"), 9 * 1024 * 1024);
    const base = repo.commit();
    repo.change("docs/user/setup.md", "Updated setup instructions.\n");
    expect(resolveQuickCiScope(repo.repo, base, repo.commit())).toMatchObject({
      kind: "none",
      packages: [],
    });
  });

  it("retains undeclared library consumers reached through a tracked helper outside workspaces", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts": 'export { value } from "../../../support/shared.js";\n',
      "support/shared.ts": 'export { value } from "./nested.js";\n',
      "support/nested.ts": 'export { value } from "@fixture/library";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it.each([
    ["js", "d.ts"],
    ["mjs", "d.mts"],
    ["cjs", "d.cts"],
  ])("follows %s declaration substitutions outside workspaces", (extension, declaration) => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts": `export { value } from "../../../support/shared.${extension}";\n`,
      [`support/shared.${declaration}`]: 'export { value } from "@fixture/library";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("uses the full gate for unresolved sources outside workspaces", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts": 'export { value } from "../../../support/generated.js";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "full",
      reason: expect.stringContaining("Unresolved source outside workspaces"),
    });
  });

  it("does not follow outside raw asset contents as TypeScript modules", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts":
        'import version from "../../../native/VERSION?raw"; export { version };\n',
      "native/VERSION": 'export { value } from "@fixture/library";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/library"],
    });
  });

  it("follows arbitrary-extension declarations outside workspaces", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer"),
      "apps/consumer/src/index.ts": 'export { value } from "../../../support/style.css";\n',
      "support/style.d.css.ts": 'export { value } from "@fixture/library";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("retains inherited include inputs when a child specifies files", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer", {
        config: { extends: "../../configs/consumer.json", files: ["src/index.ts"] },
      }),
      "apps/consumer/src/index.ts": "export const child = 1;\n",
      "configs/consumer.json": JSON.stringify({ include: ["../support/shared.d.ts"] }),
      "support/shared.d.ts": 'export { value } from "@fixture/library";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("follows workspace subpaths in TypeScript type-package inputs", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer", {
        config: { include: ["src"], compilerOptions: { types: ["@fixture/library/global"] } },
      }),
      "apps/consumer/src/index.ts": "export const child = 1;\n",
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("uses the full gate for unsupported relative TypeScript type-package inputs", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer", {
        config: { include: ["src"], compilerOptions: { types: ["../../support/types"] } },
      }),
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "full",
      reason: expect.stringContaining("Unsupported relative TypeScript type package"),
    });
  });

  it("scans an explicitly included source outside workspaces for library dependencies", () => {
    const repo = fixture({
      ...workspace("apps/consumer", "@fixture/consumer", {
        config: { extends: "../../tsconfig.base.json", include: ["src", "../../support/*.ts"] },
      }),
      "apps/consumer/src/index.ts": "export const value = 1;\n",
      "support/shared.ts": 'export { value } from "@fixture/library";\n',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("skips typechecks for known static assets", () => {
    const repo = fixture();
    repo.change("apps/unrelated/public/logo.png", "image bytes");
    repo.change("docs/assets/example.webp", "image bytes");
    expect(repo.scope()).toMatchObject({ kind: "none", packages: [] });
  });

  it("checks source files in docs when tsconfig includes them", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: { extends: "../../tsconfig.base.json", include: ["src", "docs"] },
      }),
    });
    repo.change("apps/unrelated/docs/example.ts", "export const example: number = 'invalid';\n");
    expect(repo.scope()).toMatchObject({ kind: "affected", packages: ["@fixture/unrelated"] });
  });

  it("does not declare an explicitly included documentation file inert", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: { extends: "../../tsconfig.base.json", include: ["src", "docs/*.md"] },
      }),
    });
    repo.change("apps/unrelated/docs/example.md", "Included by this project's config.\n");
    expect(repo.scope()).toMatchObject({ kind: "affected", packages: ["@fixture/unrelated"] });
  });

  it.each([
    ["*.md", "note.md", true],
    ["*.md", "nested/note.md", false],
    ["?.md", "a.md", true],
    ["?.md", "ab.md", false],
    ["?.md", "😀.md", false],
    ["**.md", "nested/note.md", true],
    ["**/*.md", "note.md", true],
    ["**/*.md", "nested/note.md", true],
    ["***/*.md", "note.md", false],
    ["****/*.md", "note.md", true],
    ["****/*.md", "nested/note.md", true],
    ["a.+^$()|.md", "a.+^$()|.md", true],
    ["*.md", "line\nbreak.md", true],
    ["**.md", "line\nbreak.md", false],
    ["nested", "nested/note.md", false],
  ])("keeps limited config glob %s for %s (included: %s)", (pattern, file, included) => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: { extends: "../../tsconfig.base.json", include: ["src", `docs/${pattern}`] },
      }),
    });
    repo.change(`apps/unrelated/docs/${file}`, "Documentation input.\n");
    expect(repo.scope()).toMatchObject({
      kind: included ? "affected" : "none",
      packages: included ? ["@fixture/unrelated"] : [],
    });
  });

  it.each(["[ab]", "{a,b}", "!a", "a\\b"])(
    "falls back to the full gate with the exact unsupported glob diagnostic: %s",
    (pattern) => {
      const repo = fixture({
        ...workspace("apps/unrelated", "@fixture/unrelated", {
          config: { include: [`docs/${pattern}`] },
        }),
      });
      repo.change("apps/unrelated/docs/note.md", "Documentation input.\n");
      expect(repo.scope()).toMatchObject({
        kind: "full",
        reason: `Cannot safely narrow typecheck: Unsupported scope pattern apps/unrelated/docs/${pattern}`,
      });
    },
  );

  it.each([
    ["tsconfig.base.json", '{"compilerOptions":{"strict":false}}'],
    ["vite.config.ts", "export default {};\n"],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
    ["pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n  - scripts\n# updated\n"],
    [".mise.toml", "[tools]\nnode = '24'\n"],
    [
      "packages/library/package.json",
      '{"name":"@fixture/library","scripts":{"typecheck":"tsc --noEmit"}}',
    ],
  ])("uses the full gate when configuration or graph input changes: %s", (file, contents) => {
    const repo = fixture();
    repo.change(file, contents);
    expect(repo.scope()).toMatchObject({
      kind: "full",
      packages: ["@fixture/consumer", "@fixture/library", "@fixture/unrelated"],
    });
  });

  it("uses the full gate for an extended configuration with a nonstandard filename", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: { extends: "./settings/compiler.json", include: ["src"] },
      }),
      "apps/unrelated/settings/compiler.json": '{"compilerOptions":{"strict":true}}',
    });
    repo.change("apps/unrelated/settings/compiler.json", '{"compilerOptions":{"strict":false}}');
    expect(repo.scope().kind).toBe("full");
  });

  it("uses the full gate for unknown code and deleted unknown paths", () => {
    const repo = fixture({ "unowned/module.ts": "export const value = 1;\n" });
    NodeFS.unlinkSync(NodePath.join(repo.repo, "unowned/module.ts"));
    expect(repo.scope()).toMatchObject({ kind: "full", changedFiles: ["unowned/module.ts"] });
  });

  it("uses the full gate when a workspace dependency cannot be resolved", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        dependencies: { missing: "workspace:*" },
      }),
    });
    repo.change("apps/unrelated/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().kind).toBe("full");
  });

  it("uses the full gate when the typecheck command does not expose a supported project", () => {
    const repo = fixture({
      "apps/unrelated/package.json": JSON.stringify({
        name: "@fixture/unrelated",
        scripts: { typecheck: "node check-other-project.js" },
      }),
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "full",
      reason: expect.stringContaining("Unsupported typecheck invocation"),
    });
  });

  it("uses the full gate when an external tsconfig base is unavailable", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: { extends: "unavailable-package/tsconfig.json", include: ["src"] },
      }),
    });
    repo.change("apps/unrelated/src/index.ts", "export const value = 2;\n");
    expect(repo.scope()).toMatchObject({
      kind: "full",
      reason: expect.stringContaining("Unresolved TypeScript extends"),
    });
  });

  it("uses the extending project's default include with an installed options-only base", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: { extends: "fixture-base/tsconfig.json" },
      }),
    });
    write(
      repo.repo,
      "node_modules/fixture-base/tsconfig.json",
      '{"compilerOptions":{"strict":true}}',
    );
    write(repo.repo, ".gitignore", "node_modules/\n");
    // Keep the ignore policy in both endpoints so only source is changed.
    const base = repo.commit();
    repo.change("apps/unrelated/docs/example.ts", "export const example = 2;\n");
    expect(resolveQuickCiScope(repo.repo, base, repo.commit())).toMatchObject({
      kind: "affected",
      packages: ["@fixture/unrelated"],
    });
  });

  it("resolves installed configDir input templates against the extending project", () => {
    const repo = fixture({
      ...workspace("apps/unrelated", "@fixture/unrelated", {
        config: { extends: "fixture-base/strict.json" },
      }),
    });
    write(repo.repo, "node_modules/fixture-base/strict.json", '{"extends":"./base.json"}');
    write(repo.repo, "node_modules/fixture-base/base.json", '{"include":["${configDir}/**/*"]}');
    write(repo.repo, ".gitignore", "node_modules/\n");
    const base = repo.commit();
    repo.change("apps/unrelated/src/index.ts", "export const example = 2;\n");
    expect(resolveQuickCiScope(repo.repo, base, repo.commit())).toMatchObject({
      kind: "affected",
      packages: ["@fixture/unrelated"],
    });
  });

  it("honors an explicit project filename in the typecheck script", () => {
    const repo = fixture({
      "apps/unrelated/package.json": JSON.stringify({
        name: "@fixture/unrelated",
        scripts: { typecheck: "tsc --noEmit --project configs/check.json" },
      }),
      "apps/unrelated/configs/check.json": '{"include":["../../../packages/library/src"]}',
    });
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    expect(repo.scope().packages).toEqual([
      "@fixture/consumer",
      "@fixture/library",
      "@fixture/unrelated",
    ]);
  });

  it("reads workspace metadata and source edges from the requested commit, ignoring later worktree edits", () => {
    const repo = fixture();
    repo.change("packages/library/src/index.ts", "export const value = 2;\n");
    const head = repo.commit();
    repo.change("apps/consumer/package.json", '{"name":"changed-local-name"}');
    repo.change("apps/consumer/src/index.ts", "export const unrelated = true;\n");
    expect(resolveQuickCiScope(repo.repo, repo.base, head)).toMatchObject({
      kind: "affected",
      packages: ["@fixture/consumer", "@fixture/library"],
    });
  });

  it("returns none for an empty exact range", () => {
    const repo = fixture();
    expect(resolveQuickCiScope(repo.repo, repo.base, repo.base)).toEqual({
      kind: "none",
      packages: [],
      reason: "No files changed",
      changedFiles: [],
    });
  });
});
