// Run explicitly: node apps/desktop/scripts/browser-surface.smoke.mjs
// --build-only prepares isolated artifacts without launching Electron.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
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
      rolldownOptions: { external: native ? [/^node:/, "electron", "playwright-core"] : [] },
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
await bundle("browser-surface.fixture.mjs", "cjs", "main.cjs", true);
await bundle("browser-surface.preload.mjs", "cjs", "preload.cjs", true);
await bundle("browser-surface.renderer.mjs", "iife", "renderer.js");
await NodeFSP.writeFile(
  NodePath.join(scratch, "index.html"),
  '<!doctype html><style>html,body{margin:0;overflow:hidden}body{background:#eee}</style><script src="renderer.js"></script>',
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
  const child = NodeChildProcess.spawnSync(
    ensureElectronRuntime(),
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
