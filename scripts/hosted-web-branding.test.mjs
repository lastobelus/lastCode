import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import { onTestFinished } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  createGeneratedBuildStage,
  inspectGeneratedBuildOwnership,
  copyOwnedGeneratedBuild,
} from "../packages/shared/src/generatedBuildOwnership.ts";
import {
  createBuildOwnershipPlugin,
  resolveHostedWebAssetBrand,
} from "../apps/web/vite/buildOwnership.ts";
import { config } from "../apps/web/vercel.ts";
import { resolveLastCodeWebIconOverrides } from "./lib/lastcode-brand-assets.ts";
import { applyWebBrandAssetsToDirectory } from "./lib/apply-web-brand-assets.ts";
import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";

const fixture = () => {
  const temporary = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hosted-branding-")),
  );
  onTestFinished(() => NodeFS.rmSync(temporary, { recursive: true, force: true }));
  const cwd = NodePath.join(temporary, "repository");
  const metadata = NodePath.join(temporary, "git-metadata");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(metadata);
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${metadata}\n`);
  for (const brand of ["development", "production", "nightly"])
    for (const override of resolveLastCodeWebIconOverrides(brand, "unused")) {
      const source = NodePath.join(cwd, override.sourceRelativePath);
      NodeFS.mkdirSync(NodePath.dirname(source), { recursive: true });
      NodeFS.writeFileSync(source, `${brand}:${NodePath.basename(source)}`);
    }
  const root = "apps/web/dist";
  const output = NodePath.join(cwd, root);
  const emit = (directory) => {
    NodeFS.mkdirSync(NodePath.join(directory, "assets"));
    NodeFS.writeFileSync(
      NodePath.join(directory, "index.html"),
      '<script src="/assets/main.js"></script>',
    );
    NodeFS.writeFileSync(NodePath.join(directory, "assets/main.js"), "compiled web");
    for (const icon of resolveLastCodeWebIconOverrides("development", directory))
      NodeFS.copyFileSync(NodePath.join(cwd, icon.sourceRelativePath), icon.targetRelativePath);
  };
  const build = createGeneratedBuildStage(cwd, root);
  emit(build.directory);
  build.publish(1);
  NodeFS.writeFileSync(NodePath.join(output, "retained-note.txt"), "retained addition");
  const ownership = () => inspectGeneratedBuildOwnership(cwd, root);
  const context = { meta: { watchMode: false } };
  return { temporary, cwd, metadata, root, output, emit, ownership, context };
};

it("brands repeated latest/nightly compiler stages, preserves prior publication until publish, then permits a normal rebuild", () => {
  const f = fixture();
  let now = 10;
  for (const channel of ["latest", "nightly", "nightly", ""]) {
    const before = f.ownership();
    const previousIcon = NodeFS.readFileSync(NodePath.join(f.output, "favicon.ico"));
    const stage = createGeneratedBuildStage(f.cwd, f.root);
    f.emit(stage.directory);
    const brand = resolveHostedWebAssetBrand(channel);
    const plugin = createBuildOwnershipPlugin(
      f.cwd,
      {
        ...stage,
        publish(...args) {
          NodeAssert.deepEqual(f.ownership(), before);
          NodeAssert.deepEqual(
            NodeFS.readFileSync(NodePath.join(f.output, "favicon.ico")),
            previousIcon,
          );
          NodeAssert.equal(
            NodeFS.readFileSync(NodePath.join(f.output, "retained-note.txt"), "utf8"),
            "retained addition",
          );
          for (const icon of resolveLastCodeWebIconOverrides(
            brand ?? "development",
            stage.directory,
          ))
            NodeAssert.deepEqual(
              NodeFS.readFileSync(icon.targetRelativePath),
              NodeFS.readFileSync(NodePath.join(f.cwd, icon.sourceRelativePath)),
            );
          stage.publish(...args);
        },
      },
      () => now++,
      brand,
    );
    plugin.buildStart.call(f.context);
    plugin.writeBundle.call(f.context);
    plugin.closeBundle.call(f.context);
    for (const icon of resolveLastCodeWebIconOverrides(brand ?? "development", f.output))
      NodeAssert.deepEqual(
        NodeFS.readFileSync(icon.targetRelativePath),
        NodeFS.readFileSync(NodePath.join(f.cwd, icon.sourceRelativePath)),
      );
    const emitted = f.ownership().files.map((file) => file.path);
    NodeAssert.equal(emitted.length, 6);
    NodeAssert.equal(emitted.includes("retained-note.txt"), false);
    const release = NodePath.join(f.temporary, `release-${now}`);
    copyOwnedGeneratedBuild(f.cwd, f.root, release);
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(release, "retained-note.txt")), false);
  }
});

it("keeps prior output and ownership intact when an exact brand asset is missing or a published icon was edited", () => {
  const f = fixture();
  for (const failure of ["missing source", "edited icon"]) {
    if (failure === "missing source") {
      const icon = resolveLastCodeWebIconOverrides("nightly", "unused").at(-1);
      NodeFS.unlinkSync(NodePath.join(f.cwd, icon.sourceRelativePath));
    } else NodeFS.writeFileSync(NodePath.join(f.output, "favicon.ico"), "user edited icon");
    const before = f.ownership();
    const bytes = NodeFS.readFileSync(NodePath.join(f.output, "favicon.ico"));
    const stage = createGeneratedBuildStage(f.cwd, f.root);
    f.emit(stage.directory);
    const plugin = createBuildOwnershipPlugin(
      f.cwd,
      stage,
      () => 20,
      failure === "missing source" ? "nightly" : "production",
    );
    plugin.buildStart.call(f.context);
    plugin.writeBundle.call(f.context);
    NodeAssert.throws(
      () => plugin.closeBundle.call(f.context),
      failure === "missing source" ? /ENOENT/ : /collision requires file review/,
    );
    NodeAssert.deepEqual(f.ownership(), before);
    NodeAssert.deepEqual(NodeFS.readFileSync(NodePath.join(f.output, "favicon.ico")), bytes);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(f.output, "retained-note.txt"), "utf8"),
      "retained addition",
    );
    NodeAssert.equal(NodeFS.existsSync(stage.directory), false);
  }
});

it.effect(
  "blocks callable and CLI branding of published managed output while allowing ordinary release directories",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const before = f.ownership();
      NodeAssert.throws(
        () => applyWebBrandAssetsToDirectory(f.cwd, "nightly", f.output),
        /requires a fresh/,
      );
      const attempted = yield* Effect.exit(
        applyWebBrandAssets("nightly", f.output).pipe(Effect.provide(NodeServices.layer)),
      );
      NodeAssert.equal(attempted._tag, "Failure");
      const cli = NodeChildProcess.spawnSync(
        process.execPath,
        [new URL("./apply-web-brand-assets.ts", import.meta.url).pathname, "production", f.output],
        { encoding: "utf8" },
      );
      NodeAssert.notEqual(cli.status, 0);
      NodeAssert.match(cli.stderr + cli.stdout, /requires a fresh/);
      NodeAssert.deepEqual(f.ownership(), before);
      const release = NodePath.join(f.temporary, "release");
      NodeFS.mkdirSync(release);
      applyWebBrandAssetsToDirectory(f.cwd, "nightly", release);
      for (const icon of resolveLastCodeWebIconOverrides("nightly", release))
        NodeAssert.deepEqual(
          NodeFS.readFileSync(icon.targetRelativePath),
          NodeFS.readFileSync(NodePath.join(f.cwd, icon.sourceRelativePath)),
        );
      const ordinary = NodePath.join(f.temporary, "ordinary");
      NodeFS.mkdirSync(NodePath.join(ordinary, ".git"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(ordinary, "apps/web/dist"), { recursive: true });
      applyWebBrandAssetsToDirectory(f.cwd, "production", NodePath.join(ordinary, "apps/web/dist"));
    }),
);

it("uses the hosted command channel default and configured output for latest/nightly instead of a post-publication copy", () => {
  const f = fixture();
  const bin = NodePath.join(f.temporary, "bin");
  NodeFS.mkdirSync(bin);
  const capture = NodePath.join(f.temporary, "capture.json");
  NodeFS.writeFileSync(
    NodePath.join(bin, "vp"),
    `#!/bin/sh\nexec "${process.execPath}" "${NodePath.join(bin, "capture.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "capture.mjs"),
    'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE, JSON.stringify({channel:process.env.VITE_HOSTED_APP_CHANNEL,args:process.argv.slice(2)}));',
  );
  for (const channel of [undefined, "latest", "nightly"]) {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture };
    if (channel === undefined) delete env.VITE_HOSTED_APP_CHANNEL;
    else env.VITE_HOSTED_APP_CHANNEL = channel;
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", config.buildCommand], {
      cwd: f.cwd,
      env,
      encoding: "utf8",
    });
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.deepEqual(JSON.parse(NodeFS.readFileSync(capture, "utf8")), {
      channel: channel ?? "latest",
      args: ["run", "--filter", "@t3tools/web", "build"],
    });
  }
  NodeAssert.equal(config.outputDirectory, "dist");
  NodeAssert.throws(() => resolveHostedWebAssetBrand("unknown"), /Unknown hosted/);
});
