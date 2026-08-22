// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  canExposeCodexThreadTool,
  materializeCodexThreadTool,
  renderCodexThreadToolWrapper,
} from "./CodexThreadTool.ts";

it("exposes persistent wrappers only on supported host environments", () => {
  assert.isTrue(canExposeCodexThreadTool("linux", { PATH: "/usr/bin" }));
  assert.isTrue(
    canExposeCodexThreadTool("darwin", {
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/usr/bin",
    }),
  );
  assert.isFalse(
    canExposeCodexThreadTool("linux", {
      APPIMAGE: "/tmp/.mount_LastCode/LastCode.AppImage",
    }),
  );
  assert.isFalse(canExposeCodexThreadTool("linux", { APPDIR: "/tmp/.mount_LastCode" }));
  assert.isTrue(canExposeCodexThreadTool("linux", { APPIMAGE: "", APPDIR: "  " }));
  assert.isFalse(canExposeCodexThreadTool("win32", {}));
});

it("renders an ordinary Node-hosted wrapper pinned to its owning home", () => {
  assert.strictEqual(
    renderCodexThreadToolWrapper({
      executablePath: "/opt/node/bin/node",
      cliEntryPath: "/opt/t3/dist/bin.mjs",
      baseDir: "/srv/lastcode home",
      stateDir: "/srv/lastcode home/userdata",
      electronRunAsNode: false,
    }),
    "#!/bin/sh\ncase \"$1\" in\n  current|list|read) command=\"$1\"; shift; exec '/opt/node/bin/node' '/opt/t3/dist/bin.mjs' thread \"$command\" --base-dir '/srv/lastcode home' --state-dir '/srv/lastcode home/userdata' \"$@\" ;;\n  \"\"|-h|--help|help) exec '/opt/node/bin/node' '/opt/t3/dist/bin.mjs' thread --help ;;\n  *) echo \"lastcode-thread: unsupported command '$1'\" >&2; exit 64 ;;\nesac\n",
  );
});

it("renders a packaged POSIX Electron wrapper with Node mode preserved", () => {
  const wrapper = renderCodexThreadToolWrapper({
    executablePath: "/opt/LastCode/lastcode",
    cliEntryPath: "/opt/LastCode/resources/app.asar/apps/server/dist/bin.mjs",
    baseDir: "/home/me/.lastcode",
    stateDir: "/home/me/.lastcode/dev",
    electronRunAsNode: true,
  });
  assert.match(wrapper, /^#!\/bin\/sh\nexport ELECTRON_RUN_AS_NODE=1\n/);
  assert.match(
    wrapper,
    /thread "\$command" --base-dir '\/home\/me\/\.lastcode' --state-dir '\/home\/me\/\.lastcode\/dev'/,
  );
});

it.effect("materializes an executable wrapper under the active state directory", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "lastcode-thread-tool-" });
    const stateDir = NodePath.join(baseDir, "userdata");
    const result = yield* materializeCodexThreadTool({
      stateDir,
      baseDir,
      executablePath: "/usr/bin/node",
      cliEntryPath: "/app/bin.mjs",
      electronRunAsNode: "0",
    });
    const stat = yield* Effect.promise(() => NodeFSP.stat(result.wrapperPath));
    const wrapper = yield* fileSystem.readFileString(result.wrapperPath);
    assert.strictEqual(result.wrapperPath, NodePath.join(stateDir, "bin", "lastcode-thread"));
    assert.ok((stat.mode & 0o111) !== 0);
    assert.isFalse(wrapper.includes("ELECTRON_RUN_AS_NODE"));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("preserves inherited Electron Node mode in a Linux wrapper", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "lastcode-thread-linux-electron-",
    });
    const result = yield* materializeCodexThreadTool({
      stateDir: NodePath.join(baseDir, "userdata"),
      baseDir,
      executablePath: "/opt/LastCode/lastcode",
      cliEntryPath: "/opt/LastCode/resources/app.asar/apps/server/dist/bin.mjs",
      electronRunAsNode: "1",
    });

    assert.match(
      yield* fileSystem.readFileString(result.wrapperPath),
      /^#!\/bin\/sh\nexport ELECTRON_RUN_AS_NODE=1\n/,
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("routes pinned flags through each real thread leaf parser", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "lastcode-thread-parser-",
    });
    const stateDir = NodePath.join(baseDir, "userdata");
    const result = yield* materializeCodexThreadTool({
      stateDir,
      baseDir,
      executablePath: process.execPath,
      cliEntryPath: NodePath.resolve(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../bin.ts",
      ),
      electronRunAsNode: "0",
    });
    for (const command of ["current", "list", "read"] as const) {
      const output = yield* Effect.tryPromise(
        () =>
          new Promise<string>((resolve, reject) => {
            NodeChildProcess.execFile(result.wrapperPath, [command, "--help"], (error, stdout) => {
              if (error) reject(error);
              else resolve(stdout);
            });
          }),
      );
      assert.match(output, new RegExp(`t3 thread ${command}`));
    }
    const unsupported = NodeChildProcess.spawnSync(result.wrapperPath, ["send"], {
      encoding: "utf8",
    });
    assert.strictEqual(unsupported.status, 64);
    assert.match(unsupported.stderr, /unsupported command 'send'/);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);
