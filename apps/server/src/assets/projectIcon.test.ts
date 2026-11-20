// @effect-diagnostics nodeBuiltinImport:off - the CLI case runs the real binary in a temp dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type ProjectIconOverride } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { readProjectIcon } from "./projectIcon.ts";

const projectId = ProjectId.make("project:icon-test");
const decode = (icon: { readonly base64: string } | null) =>
  Buffer.from(icon?.base64 ?? "", "base64");

const png = (width: number, bytes: number) => {
  const image = new Uint8Array(bytes);
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(image.buffer).setUint32(16, width);
  new DataView(image.buffer).setUint32(20, width);
  return image;
};

const icns = (...entries: ReadonlyArray<Uint8Array>) => {
  const length = 8 + entries.reduce((total, data) => total + 8 + data.length, 0);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("icns"));
  view.setUint32(4, length);
  let offset = 8;
  for (const data of entries) {
    bytes.set(new TextEncoder().encode("ic10"), offset);
    view.setUint32(offset + 4, 8 + data.length);
    bytes.set(data, offset + 8);
    offset += 8 + data.length;
  }
  return bytes;
};

it.effect("reads a bounded project icon using sidebar precedence", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-icon-" });
    const workspaceRoot = NodePath.join(root, "workspace");
    yield* fs.makeDirectory(workspaceRoot);
    let row: ProjectStore.ProjectRow = {
      projectId,
      title: "Icon test",
      hasCustomTitle: false,
      workspaceRoot,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      pinnedAt: null,
      archivedAt: null,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    };
    const readIcon = (patch: {
      readonly faviconPath?: string | null;
      readonly projectIcon?: ProjectIconOverride | null;
    }) => {
      row = { ...row, ...patch };
      return readProjectIcon(projectId).pipe(
        Effect.provide([
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => Effect.succeed(id === projectId ? Option.some(row) : Option.none()),
          }),
          ProjectFaviconResolver.layer.pipe(
            Layer.provide(T3ProjectFileLoader.layer),
            Layer.provideMerge(WorkspacePaths.layer),
          ),
          ServerConfig.layerTest(root, { prefix: "t3-project-icon-state-" }),
        ]),
      );
    };

    assert.isNull(yield* readIcon({}));

    const repoIcon = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>';
    yield* fs.writeFileString(NodePath.join(workspaceRoot, "favicon.svg"), repoIcon);
    assert.deepEqual(yield* readIcon({}), {
      mediaType: "image/svg+xml",
      base64: Buffer.from(repoIcon).toString("base64"),
    });

    const picked = NodePath.join(root, "picked.svg");
    const pickedIcon = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4"/></svg>';
    yield* fs.writeFileString(picked, pickedIcon);
    const emoji = yield* readIcon({
      faviconPath: picked,
      projectIcon: { kind: "emoji", emoji: "🛠<&" },
    });
    assert.include(decode(emoji).toString(), "🛠&lt;&amp;");

    const glyph = yield* readIcon({
      projectIcon: { kind: "lucide", name: "message-square-dashed", color: "blue" },
    });
    assert.include(decode(glyph).toString(), 'stroke="#2563eb"');
    assert.include(decode(glyph).toString(), "lucide-message-square-dashed");
    const unknown = yield* readIcon({
      projectIcon: { kind: "lucide", name: "not-a-lucide-icon", color: "gray" },
    });
    assert.include(decode(unknown).toString(), "lucide-folder-code");

    assert.deepEqual(yield* readIcon({ projectIcon: null }), {
      mediaType: "image/svg+xml",
      base64: Buffer.from(pickedIcon).toString("base64"),
    });

    yield* fs.writeFileString(picked, "x".repeat(128 * 1024 + 1));
    assert.isNull(yield* readIcon({}));

    // Width alone would pick the 1024px entry, which is over the limit.
    const app = NodePath.join(root, "app.icns");
    yield* fs.writeFile(app, icns(png(64, 400), png(1024, 200 * 1024)));
    assert.deepEqual(yield* readIcon({ faviconPath: app }), {
      mediaType: "image/png",
      base64: Buffer.from(png(64, 400)).toString("base64"),
    });
    yield* fs.writeFile(app, icns(png(1024, 200 * 1024)));
    assert.isNull(yield* readIcon({}));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("prints JSON from the CLI without creating a missing state directory", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-project-icon-cli-"));
  try {
    const baseDir = NodePath.join(root, "state");
    const workspaceRoot = NodePath.join(root, "workspace");
    NodeFS.mkdirSync(workspaceRoot);
    const repoIcon = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>';
    NodeFS.writeFileSync(NodePath.join(workspaceRoot, "favicon.svg"), repoIcon);
    const cli = (...args: ReadonlyArray<string>) => {
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.resolve(import.meta.dirname, "../bin.ts"), ...args],
        { encoding: "utf8" },
      );
      assert.strictEqual(result.status, 0, result.stderr);
      return result.stdout;
    };

    const added = cli("project", "add", workspaceRoot, "--base-dir", baseDir);
    const id = /Added project (\S+) /.exec(added)?.[1];
    assert.isDefined(id);
    assert.strictEqual(
      cli("project", "icon", id!, "--json", "--base-dir", baseDir),
      `${JSON.stringify({ mediaType: "image/svg+xml", base64: Buffer.from(repoIcon).toString("base64") })}\n`,
    );

    const missing = NodePath.join(root, "missing");
    assert.strictEqual(cli("project", "icon", id!, "--json", "--base-dir", missing), "null\n");
    assert.isFalse(NodeFS.existsSync(missing));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
