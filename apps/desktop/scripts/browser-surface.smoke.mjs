// Run explicitly: node apps/desktop/scripts/browser-surface.smoke.mjs; --build-only skips Electron.
// Use --existing-electron to avoid runtime installation.
// --react-lifecycle, --credential-access, --keyboard-channel, and --open-link select focused proofs.
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
const serverDirectory = NodePath.resolve(directory, "../../server");
const repositoryDirectory = NodePath.resolve(desktopDirectory, "../..");
const reactLifecycle = process.argv.includes("--react-lifecycle");
const credentialAccessOnly = process.argv.includes("--credential-access");
const keyboardChannelOnly = process.argv.includes("--keyboard-channel");
const openLink = process.argv.includes("--open-link");
NodeAssert.ok(
  [reactLifecycle, credentialAccessOnly, keyboardChannelOnly, openLink].filter(Boolean).length <= 1,
  "Select one integration scenario.",
);
const webDirectory = NodePath.resolve(directory, "../../web");
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "browser-surface-smoke-"));
const require = NodeModule.createRequire(NodePath.resolve(directory, "../../server/package.json"));
const desktopRequire = NodeModule.createRequire(NodePath.join(desktopDirectory, "package.json"));
const { parse } = desktopRequire("acorn");
// Playwright's pinned runtime already bundles its WebSocket server implementation.
const wsModulePath = NodePath.join(
  NodePath.dirname(require.resolve("playwright-core/package.json")),
  "lib/utilsBundle.js",
);
await NodeFSP.mkdir(NodePath.join(scratch, "user-data"));
const fixtureModules = NodePath.join(scratch, "node_modules");
await NodeFSP.mkdir(fixtureModules);
const linkedPackages = new Set();
for (const owner of [desktopDirectory, serverDirectory, repositoryDirectory]) {
  const installed = NodePath.join(owner, "node_modules");
  for (const entry of await NodeFSP.readdir(installed, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const names = entry.name.startsWith("@")
      ? (await NodeFSP.readdir(NodePath.join(installed, entry.name))).map(
          (name) => `${entry.name}/${name}`,
        )
      : [entry.name];
    for (const name of names) {
      if (linkedPackages.has(name)) continue;
      const destination = NodePath.join(fixtureModules, name);
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFSP.symlink(
        await NodeFSP.realpath(NodePath.join(installed, name)),
        destination,
        "dir",
      );
      linkedPackages.add(name);
    }
  }
}
const emittedChunks = [];
const emittedFiles = new Set();
async function bundle(entry, format, output, native = false) {
  const fixtureBoundary = NodePath.join(
    directory,
    openLink ? "browser-open-link.state.fixture.mjs" : "browser-surface.react-state.fixture.mjs",
  );
  const fixtureModules = new Set(
    (openLink
      ? [
          "state/primaryEnvironment",
          "state/session",
          "state/entities",
          "state/preview",
          "state/use-atom-command",
          "hooks/useSettings",
          "components/preview/previewHostingRecovery",
          "assets/assetUrls",
          "lib/utils",
        ]
      : [
          "state/primaryEnvironment",
          "state/session",
          "state/preview",
          "state/entities",
          "state/use-atom-command",
          "connection/catalog",
          "hooks/useSettings",
          "previewStateStore",
          "components/preview/usePreviewSession",
          "components/preview/usePreviewBridge",
          "components/preview/previewHostingRecovery",
          "components/ui/toast",
          "lib/utils",
          "browser/DesktopCdpRelay",
          "browser/useDesktopBrowserSessions",
          "browser/browserRecording",
          "browser/openFileInPreview",
          "browser/BrowserDeviceToolbar",
        ]
    ).map((path) => NodePath.join(webDirectory, "src", path)),
  );
  const result = await build({
    configFile: false,
    logLevel: "error",
    // Library builds retain React's environment probe unless explicitly replaced for a browser.
    ...(!native ? { define: { "process.env.NODE_ENV": JSON.stringify("production") } } : {}),
    ...(native ? { resolve: { conditions: ["node"], mainFields: ["module", "main"] } } : {}),
    ...((reactLifecycle || openLink) && !native
      ? {
          root: webDirectory,
          resolve: {
            alias: { "~": NodePath.join(webDirectory, "src") },
            dedupe: ["react", "react-dom", "zustand", "@effect/atom-react"],
          },
          plugins: [
            {
              name: "react-smoke-external-state",
              enforce: "pre",
              resolveId(id, importer) {
                const path = id.startsWith("~/")
                  ? NodePath.join(webDirectory, "src", id.slice(2))
                  : id.startsWith(".") && importer
                    ? NodePath.resolve(NodePath.dirname(importer), id)
                    : id;
                if (fixtureModules.has(path.replace(/\.(tsx?|mjs)$/, ""))) return fixtureBoundary;
              },
            },
          ],
        }
      : {}),
    build: {
      write: false,
      minify: false,
      target: native ? "node24" : "chrome144",
      lib: { entry: NodePath.join(directory, entry), formats: [format], name: "SurfaceSmoke" },
      rolldownOptions: {
        ...(native ? { platform: "node" } : {}),
        output: {
          entryFileNames: output,
          chunkFileNames: `${NodePath.parse(output).name}-[name]-[hash].${format === "cjs" ? "cjs" : "js"}`,
          assetFileNames: `${NodePath.parse(output).name}-[name]-[hash][extname]`,
        },
        external: native
          ? [
              ...NodeModule.builtinModules,
              /^node:/,
              "electron",
              "playwright-core",
              "ffi-rs",
              "@napi-rs/keyring",
            ]
          : [],
      },
    },
  });
  const files = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
  NodeAssert.ok(
    files.some((file) => file.type === "chunk" && file.isEntry && file.fileName === output),
    `Missing ${entry} entry bundle ${output}`,
  );
  for (const file of files) {
    if (file.type === "chunk") {
      if (!native)
        NodeAssert.doesNotMatch(
          file.code,
          /\bprocess\.env\.NODE_ENV\b/,
          "Browser bundle contains an unbound Node environment probe",
        );
      emittedChunks.push(file);
    }
    const destination = NodePath.join(scratch, file.fileName);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, file.type === "chunk" ? file.code : file.source);
    emittedFiles.add(file.fileName);
  }
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
const fixturePrefix = openLink
  ? "browser-open-link"
  : reactLifecycle
    ? "browser-surface.react"
    : "browser-surface";
await bundle(`${fixturePrefix}.fixture.mjs`, "cjs", "main.cjs", true);
await bundle(`${fixturePrefix}.preload.mjs`, "cjs", "preload.cjs", true);
await bundle(`${fixturePrefix}.renderer.mjs`, "iife", "renderer.js");
if (reactLifecycle)
  await bundle("../src/preview-pick-preload.ts", "cjs", "preview-pick-preload.cjs", true);
const productionModules = openLink
  ? [
      "apps/web/src/browser/useOpenLink.ts",
      "apps/web/src/browser/browserLinkTarget.ts",
      "apps/web/src/browser/browserDefaults.ts",
      "apps/web/src/browser/openFileInPreview.ts",
      "apps/web/src/browser/preparedPreviewOpenTarget.ts",
      "apps/web/src/browser/previewRuntime.ts",
      "apps/web/src/previewStateStore.ts",
      "apps/web/src/rightPanelStore.ts",
      "apps/web/src/browserHistoryStore.ts",
      "apps/web/src/localApi.ts",
      "packages/client-runtime/src/previewHosting.ts",
      "apps/desktop/src/preload.ts",
    ]
  : reactLifecycle
    ? [
        "apps/web/src/browser/ElectronBrowserHost.tsx",
        "apps/web/src/browser/HostedBrowserWebview.tsx",
        "apps/web/src/browser/desktopTabLifetime.ts",
        "apps/web/src/components/preview/previewBridge.ts",
        "packages/client-runtime/src/previewHosting.ts",
        "apps/desktop/src/preload.ts",
        "apps/desktop/src/ipc/methods/preview.ts",
        "apps/desktop/src/preview/Manager.ts",
        "apps/desktop/src/preview/DesktopBrowserHost.ts",
        "apps/desktop/src/preview/NativeBrowserLifetime.ts",
      ]
    : [];
for (const path of productionModules)
  NodeAssert.ok(
    emittedChunks.some((chunk) =>
      Object.keys(chunk.modules).includes(NodePath.join(repositoryDirectory, path)),
    ),
    `Integration smoke must bundle the production module ${path}`,
  );
let verifiedRelativeImports = 0;
const externalReferences = new Set();
for (const chunk of emittedChunks) {
  const references = new Set([...chunk.imports, ...chunk.dynamicImports]);
  const nodes = [parse(chunk.code, { ecmaVersion: "latest", sourceType: "module" })];
  const requireAliases = new Set(["require", "__require"]);
  const calls = [];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "CallExpression" &&
      ((node.init.callee.type === "Identifier" && node.init.callee.name === "createRequire") ||
        (node.init.callee.type === "MemberExpression" &&
          node.init.callee.property.name === "createRequire"))
    )
      requireAliases.add(node.id.name);
    if (node.type === "CallExpression") calls.push(node);
    if (node.type === "ImportExpression" && typeof node.source.value === "string")
      references.add(node.source.value);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) nodes.push(child);
      } else if (value?.type) nodes.push(value);
    }
  }
  for (const call of calls) {
    const loader =
      (call.callee.type === "Identifier" && requireAliases.has(call.callee.name)) ||
      (call.callee.type === "MemberExpression" &&
        call.callee.object.type === "Identifier" &&
        ((call.callee.object.name === "module" && call.callee.property.name === "require") ||
          (requireAliases.has(call.callee.object.name) &&
            call.callee.property.name === "resolve")));
    if (loader && typeof call.arguments[0]?.value === "string")
      references.add(call.arguments[0].value);
  }
  for (const reference of references) {
    const destination = reference.startsWith(".")
      ? NodePath.resolve(scratch, NodePath.dirname(chunk.fileName), reference)
      : emittedFiles.has(reference)
        ? NodePath.join(scratch, reference)
        : undefined;
    if (destination === undefined) {
      if (!NodeModule.isBuiltin(reference) && !NodePath.isAbsolute(reference))
        externalReferences.add(reference);
      continue;
    }
    NodeAssert.ok(
      (await NodeFSP.stat(destination)).isFile(),
      `Missing generated import ${reference} from ${chunk.fileName}`,
    );
    verifiedRelativeImports += 1;
  }
}
const fixtureRequire = NodeModule.createRequire(NodePath.join(scratch, "main.cjs"));
for (const reference of externalReferences) fixtureRequire.resolve(reference);
const externalLoads = [...externalReferences]
  .filter((reference) => reference !== "electron")
  .sort();
const dependencyProbe = NodeChildProcess.spawnSync(
  process.execPath,
  [
    "--input-type=commonjs",
    "-e",
    `for (const name of ${JSON.stringify(externalLoads)}) require(name);`,
  ],
  { cwd: scratch, encoding: "utf8", timeout: 10000 },
);
NodeAssert.equal(dependencyProbe.error, undefined, dependencyProbe.error?.message);
NodeAssert.equal(
  dependencyProbe.status,
  0,
  `Fixture external dependency load failed: ${dependencyProbe.stderr}`,
);
await NodeFSP.writeFile(
  NodePath.join(scratch, "bootstrap.cjs"),
  `const { app } = require("electron");
app.setPath("userData", require("node:path").join(process.argv[2], "user-data"));
const fail = cause => {
  console.error("Browser surface fixture bootstrap failed:", cause?.stack ?? cause);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
try { require("./main.cjs"); } catch (cause) { fail(cause); }
`,
);
await NodeFSP.writeFile(
  NodePath.join(scratch, "index.html"),
  `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden}body{background:#eee}${
    reactLifecycle
      ? ".contents{display:contents}.fixed{position:fixed}.relative{position:relative}.absolute{position:absolute}.flex{display:flex}.overflow-hidden{overflow:hidden}"
      : ""
  }</style></head><body><script src="renderer.js"></script></body></html>`,
);
const manifest = {
  scratch,
  main: NodePath.join(scratch, "main.cjs"),
  bootstrap: NodePath.join(scratch, "bootstrap.cjs"),
  wsModulePath,
  generatedFiles: [...emittedFiles].sort(),
  ...(reactLifecycle || openLink ? { productionModules } : {}),
  verifiedRelativeImports,
  verifiedExternalImports: [...externalReferences].sort(),
  verifiedExternalLoads: externalLoads,
  scope: openLink
    ? "hidden native Electron renderer click with production useOpenLink, prepared target, panel/focus/history stores, local API and preload; fixture settings hydration, owner scope/capability, lease/recovery and Browser RPC; no remote WS, full app hydration or server Browser page"
    : reactLifecycle
      ? "production React ElectronBrowserHost/HostedBrowserWebview, desktop preload, IPC, Manager and native host; fixture remote config/hosting responses, injected connection generation and monotonic time; no real WS reconnect or live data"
      : "ordinary hidden Electron fixture, including real named-profile guest lifecycle and 32-page capacity; never launches the installed app or reads live user data",
};
console.log(JSON.stringify(manifest));
if (!process.argv.includes("--build-only")) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.VITE_DEV_SERVER_URL;
  delete environment.T3CODE_HOME;
  const electronRuntime =
    openLink || process.argv.includes("--existing-electron")
      ? await existingElectronRuntime()
      : ensureElectronRuntime();
  const child = NodeChildProcess.spawnSync(
    electronRuntime,
    [
      manifest.bootstrap,
      scratch,
      wsModulePath,
      ...(credentialAccessOnly ? ["--credential-access"] : []),
      ...(keyboardChannelOnly ? ["--keyboard-channel"] : []),
    ],
    {
      encoding: "utf8",
      env: environment,
      timeout: reactLifecycle ? 120000 : 60000,
      killSignal: "SIGKILL",
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
