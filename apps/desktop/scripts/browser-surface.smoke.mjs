// Run explicitly: node apps/desktop/scripts/browser-surface.smoke.mjs
// --build-only prepares isolated artifacts without launching Electron.
// --existing-electron uses the installed dependency without repairing or downloading a runtime.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDirectory = NodePath.resolve(directory, "..");
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "browser-surface-smoke-"));
const require = NodeModule.createRequire(NodePath.resolve(directory, "../../server/package.json"));
// Playwright's pinned runtime already bundles its WebSocket server implementation.
const wsModulePath = NodePath.join(
  NodePath.dirname(require.resolve("playwright-core/package.json")),
  "lib/utilsBundle.js",
);
await NodeFSP.mkdir(NodePath.join(scratch, "user-data"));
await NodeFSP.symlink(
  NodePath.join(desktopDirectory, "node_modules"),
  NodePath.join(scratch, "node_modules"),
  "dir",
);
async function bundle(entry, format, output, native = false) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    // Library builds retain React's environment probe unless explicitly replaced for a browser.
    ...(!native ? { define: { "process.env.NODE_ENV": JSON.stringify("production") } } : {}),
    build: {
      write: false,
      minify: false,
      target: native ? "node24" : "chrome144",
      lib: { entry: NodePath.join(directory, entry), formats: [format], name: "SurfaceSmoke" },
      rolldownOptions: {
        external: native
          ? [/^node:/, "electron", "playwright-core", "ffi-rs", "@napi-rs/keyring"]
          : [],
      },
    },
  });
  const code = (Array.isArray(result) ? result[0] : result).output.find(
    (chunk) => chunk.type === "chunk",
  )?.code;
  NodeAssert.ok(code, `Missing ${entry} bundle`);
  if (!native)
    NodeAssert.doesNotMatch(
      code,
      /\bprocess\.env\.NODE_ENV\b/,
      "Browser bundle contains an unbound Node environment probe",
    );
  await NodeFSP.writeFile(NodePath.join(scratch, output), code);
}
async function existingElectronRuntime() {
  const desktopRequire = NodeModule.createRequire(NodePath.join(desktopDirectory, "package.json"));
  // Resolving package metadata never evaluates Electron's entrypoint, which can download a runtime.
  const electronDirectory = NodePath.dirname(desktopRequire.resolve("electron/package.json"));
  const executablePath = (
    await NodeFSP.readFile(NodePath.join(electronDirectory, "path.txt"), "utf8")
  ).trim();
  NodeAssert.ok(executablePath, "Existing Electron path.txt must identify an executable");
  const executable = NodePath.join(electronDirectory, "dist", executablePath);
  NodeAssert.ok(
    (await NodeFSP.stat(executable)).isFile(),
    "Existing Electron executable must be a file",
  );
  await NodeFSP.access(executable, NodeFS.constants.X_OK);
  return executable;
}
await bundle("browser-surface.fixture.mjs", "cjs", "main.cjs", true);
await bundle("browser-surface.preload.mjs", "cjs", "preload.cjs", true);
await bundle("browser-surface.renderer.mjs", "iife", "renderer.js");
await NodeFSP.writeFile(
  NodePath.join(scratch, "index.html"),
  '<!doctype html><html><head><style>html,body{margin:0;overflow:hidden}body{background:#eee}</style></head><body><script src="renderer.js"></script></body></html>',
);
const manifest = {
  scratch,
  main: NodePath.join(scratch, "main.cjs"),
  wsModulePath,
  scope:
    "ordinary hidden Electron fixture; never launches the installed app or reads live user data",
};
console.log(JSON.stringify(manifest));
if (!process.argv.includes("--build-only")) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.VITE_DEV_SERVER_URL;
  delete environment.T3CODE_HOME;
  const electronRuntime = process.argv.includes("--existing-electron")
    ? await existingElectronRuntime()
    : ensureElectronRuntime();
  const child = NodeChildProcess.spawnSync(
    electronRuntime,
    [manifest.main, scratch, wsModulePath],
    {
      encoding: "utf8",
      env: environment,
      timeout: 60000,
    },
  );
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  NodeAssert.equal(child.error, undefined, child.error?.message);
  NodeAssert.equal(
    child.status,
    0,
    `Browser surface fixture exited ${child.status ?? "without status"}. Artifacts: ${scratch}`,
  );
}
