// @effect-diagnostics nodeBuiltinImport:off
import { createPackage } from "@electron/asar";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR,
  LASTCODE_PACKAGED_RUNTIME_SENTINEL,
  preparePackagedServerRuntime,
  readPackagedServerRuntimeIdentity,
  validatePackagedServerRuntime,
  type PackagedAppInspection,
} from "./lastcode-packaged-server-runtime.ts";
import {
  createPackagedServerServicePlan,
  LASTCODE_PACKAGED_SERVER_SERVICE_LABEL,
  packagedServerProgramArguments,
  renderPackagedServerLaunchAgent,
} from "./lastcode-packaged-server-service.ts";
import {
  preparePackagedServerSupervisor,
  validatePackagedServerSupervisor,
} from "./lastcode-packaged-server-supervisor.ts";

const VERSION = "0.0.34-nightly.20260819.1133";
const TAG = `lastcode/checkpoint/v${VERSION}`;
const BUILD_TAG = `lastcode/build/v${VERSION}.1`;
const COMMIT = "a".repeat(40);
const SERVER_VERSION = "0.0.33";
const temporaryDirectories: string[] = [];

function makeTreeWritable(path: string): void {
  const stat = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) return;
  NodeFS.chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) {
    for (const entry of NodeFS.readdirSync(path)) makeTreeWritable(NodePath.join(path, entry));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    makeTreeWritable(directory);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "lastcode-packaged-runtime-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function programArgumentsFromPlist(plist: string): ReadonlyArray<string> {
  const result = NodeChildProcess.spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    { encoding: "utf8", input: plist },
  );
  if (result.status !== 0) {
    throw new Error(`Could not decode rendered LaunchAgent: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout) as { readonly ProgramArguments?: unknown };
  if (
    !Array.isArray(parsed.ProgramArguments) ||
    !parsed.ProgramArguments.every((argument) => typeof argument === "string")
  ) {
    throw new Error("Rendered LaunchAgent has invalid ProgramArguments.");
  }
  return parsed.ProgramArguments;
}

function writeBuildManifest(root: string, overrides: Record<string, unknown> = {}) {
  const path = NodePath.join(root, "build-manifest.json");
  NodeFS.writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        arch: "x64",
        buildTag: BUILD_TAG,
        checkpointTag: TAG,
        lastCodeCommit: COMMIT,
        platform: "mac",
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

async function createPackagedApp(root: string) {
  const appPath = NodePath.join(root, "source", "LastCode.app");
  const executablePath = NodePath.join(appPath, "Contents", "MacOS", "LastCode");
  const resourcesPath = NodePath.join(appPath, "Contents", "Resources");
  const asarSource = NodePath.join(root, "asar-source");
  NodeFS.mkdirSync(NodePath.dirname(executablePath), { recursive: true });
  NodeFS.mkdirSync(resourcesPath, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(asarSource, "apps", "server", "dist"), { recursive: true });
  NodeFS.writeFileSync(executablePath, "packaged-electron");
  NodeFS.chmodSync(executablePath, 0o755);
  NodeFS.writeFileSync(
    NodePath.join(asarSource, "package.json"),
    JSON.stringify({
      name: "lastcode",
      version: VERSION,
      buildVersion: VERSION,
      t3codeCommitHash: COMMIT.slice(0, 12),
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(asarSource, "apps", "server", "dist", "bin.mjs"),
    "console.log('LastCode server');\n",
  );
  await createPackage(asarSource, NodePath.join(resourcesPath, "app.asar"));
  return appPath;
}

function inspection(overrides: Partial<PackagedAppInspection> = {}): PackagedAppInspection {
  return {
    readBundleValue: (_appPath, key) =>
      key === "CFBundleIdentifier" ? "codes.lastobelus.lastcode" : VERSION,
    readArchitectures: () => ["x86_64"],
    verifyCodeSignature: () => undefined,
    probeServerVersion: () => `t3 v${SERVER_VERSION}`,
    ...overrides,
  };
}

it("keeps packaged server modules inside the desktop shared-script boundary", () => {
  for (const file of [
    "lastcode-installable-tag.ts",
    "lastcode-packaged-server-runtime.ts",
    "lastcode-packaged-server-service.ts",
    "lastcode-packaged-server-supervisor.ts",
  ]) {
    const source = NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");
    expect(source).not.toMatch(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']\.\.\//);
  }
});

describe("LastCode packaged server runtime", () => {
  it("derives one exact x64 LastCode identity from the durable build manifest", () => {
    const root = temporaryDirectory();
    expect(readPackagedServerRuntimeIdentity(writeBuildManifest(root))).toEqual({
      product: "LastCode",
      version: VERSION,
      tag: TAG,
      buildTag: BUILD_TAG,
      commit: COMMIT,
      platform: "darwin",
      arch: "x64",
      bundleId: "codes.lastobelus.lastcode",
    });
    expect(() =>
      readPackagedServerRuntimeIdentity(writeBuildManifest(root, { arch: "arm64" })),
    ).toThrow("Invalid LastCode build manifest");
    expect(() =>
      readPackagedServerRuntimeIdentity(
        writeBuildManifest(root, { buildTag: "lastcode/build/v9.9.9.1" }),
      ),
    ).toThrow("does not belong");
    expect(() =>
      readPackagedServerRuntimeIdentity(
        writeBuildManifest(root, { buildTag: `${BUILD_TAG}.unexpected` }),
      ),
    ).toThrow("does not belong");
  });

  it("publishes the descriptor and checksum sentinel only after the copied app validates", async () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const sourceAppPath = await createPackagedApp(root);
    let inspections = 0;
    const runtime = preparePackagedServerRuntime({
      buildManifestPath: writeBuildManifest(root),
      sourceAppPath,
      runtimeRoot,
      inspection: inspection({
        verifyCodeSignature: () => {
          inspections += 1;
        },
      }),
    });

    expect(inspections).toBe(3);
    expect(runtime.descriptor).toMatchObject({
      product: "LastCode",
      version: VERSION,
      tag: TAG,
      buildTag: BUILD_TAG,
      commit: COMMIT,
      arch: "x64",
      bundleId: "codes.lastobelus.lastcode",
      serverVersion: SERVER_VERSION,
      executable: "LastCode.app/Contents/MacOS/LastCode",
      serverEntry: "LastCode.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    });
    expect(runtime.executablePath).not.toContain("node_modules/t3");
    expect(NodeFS.statSync(runtime.descriptorPath).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(runtime.sentinelPath).mode & 0o777).toBe(0o600);

    const rawDescriptor = NodeFS.readFileSync(runtime.descriptorPath, "utf8");
    const sentinel = JSON.parse(NodeFS.readFileSync(runtime.sentinelPath, "utf8")) as {
      descriptorSha256: string;
    };
    expect(sentinel.descriptorSha256).toBe(
      NodeCrypto.createHash("sha256").update(rawDescriptor).digest("hex"),
    );
    expect(
      NodeFS.existsSync(NodePath.join(runtime.versionDir, LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR)),
    ).toBe(true);
    expect(
      NodeFS.existsSync(NodePath.join(runtime.versionDir, LASTCODE_PACKAGED_RUNTIME_SENTINEL)),
    ).toBe(true);
  });

  it("fails closed when a completed packaged runtime is modified", async () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const runtime = preparePackagedServerRuntime({
      buildManifestPath: writeBuildManifest(root),
      sourceAppPath: await createPackagedApp(root),
      runtimeRoot,
      inspection: inspection(),
    });
    NodeFS.appendFileSync(runtime.executablePath, "tampered");

    expect(() =>
      validatePackagedServerRuntime({
        runtimeRoot,
        identity: readPackagedServerRuntimeIdentity(NodePath.join(root, "build-manifest.json")),
        inspection: inspection(),
      }),
    ).toThrow("checksums do not match");
    expect(() =>
      preparePackagedServerRuntime({
        buildManifestPath: NodePath.join(root, "build-manifest.json"),
        sourceAppPath: NodePath.join(root, "source", "LastCode.app"),
        runtimeRoot,
        inspection: inspection(),
      }),
    ).toThrow("checksums do not match");
    expect(NodeFS.readFileSync(runtime.executablePath, "utf8")).toContain("tampered");
  });

  it("never publishes a candidate whose staged copy fails validation", async () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const sourceAppPath = await createPackagedApp(root);
    let validations = 0;
    expect(() =>
      preparePackagedServerRuntime({
        buildManifestPath: writeBuildManifest(root),
        sourceAppPath,
        runtimeRoot,
        inspection: inspection({
          probeServerVersion: () => {
            validations += 1;
            return validations === 1 ? `t3 v${SERVER_VERSION}` : "not-a-version";
          },
        }),
      }),
    ).toThrow("preflight reported no valid version");
    expect(NodeFS.readdirSync(NodePath.join(runtimeRoot, "versions"))).toEqual([]);
  });

  it("rejects packaged app symlinks that would escape the durable runtime", async () => {
    const root = temporaryDirectory();
    const sourceAppPath = await createPackagedApp(root);
    NodeFS.symlinkSync(
      NodePath.join(root, "outside"),
      NodePath.join(sourceAppPath, "Contents", "outside"),
    );

    expect(() =>
      preparePackagedServerRuntime({
        buildManifestPath: writeBuildManifest(root),
        sourceAppPath,
        runtimeRoot: NodePath.join(root, "runtime", "packaged-server"),
        inspection: inspection(),
      }),
    ).toThrow("symlink outside its application bundle");
  });
});

describe("LastCode packaged server LaunchAgent candidate", () => {
  it("runs a stable preflight outside the candidate before the packaged server", async () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const runtime = preparePackagedServerRuntime({
      buildManifestPath: writeBuildManifest(root),
      sourceAppPath: await createPackagedApp(root),
      runtimeRoot,
      inspection: inspection(),
    });
    const supervisor = preparePackagedServerSupervisor({ runtimeRoot });
    const nodePath = NodeFS.realpathSync(process.execPath);
    const plan = createPackagedServerServicePlan({
      homeDir: "/Users/Last & Code",
      nodePath,
      supervisor,
      runtime,
    });
    const plist = renderPackagedServerLaunchAgent(plan);
    const programArguments = packagedServerProgramArguments(plan);
    expect(programArgumentsFromPlist(plist)).toEqual(programArguments);

    expect(LASTCODE_PACKAGED_SERVER_SERVICE_LABEL).not.toBe("codes.lastobelus.lastcode");
    expect(LASTCODE_PACKAGED_SERVER_SERVICE_LABEL).not.toBe("com.t3tools.t3code.service");
    expect(plist).toContain(`<string>${LASTCODE_PACKAGED_SERVER_SERVICE_LABEL}</string>`);
    expect(plist).toContain("<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>");
    expect(plist).toContain("<key>NODE_OPTIONS</key>\n    <string></string>");
    expect(plist).toContain("<key>NODE_PATH</key>\n    <string></string>");
    expect(plist).toContain(nodePath);
    expect(plist).toContain(supervisor.path);
    expect(plist).toContain(runtime.descriptorPath);
    expect(plist).toContain(runtime.descriptorSha256);
    expect(plist).toContain(BUILD_TAG);
    expect(NodePath.relative(runtime.versionDir, nodePath)).toMatch(/^\.\./);
    expect(NodePath.relative(runtime.versionDir, supervisor.path)).toMatch(/^\.\./);
    expect(NodeFS.statSync(supervisor.path).mode & 0o777).toBe(0o400);
    expect(programArguments).toMatchObject([
      nodePath,
      "--no-global-search-paths",
      "-e",
      expect.stringContaining('createHash("sha256")'),
      plan.supervisor.path,
      supervisor.sha256,
      runtime.descriptorPath,
    ]);
    expect(plist.indexOf(nodePath)).toBeLessThan(plist.indexOf(plan.supervisor.path));
    expect(plist).not.toContain(runtime.executablePath);
    expect(plist).not.toContain(runtime.serverEntryPath);
    expect(plist).toContain("<string>/Users/Last &amp; Code/.lastcode</string>");
    expect(plist).toContain("/mise/shims:/Users/Last &amp; Code/.local/bin:/usr/local/bin");
    expect(plist).toContain("packaged-server-service.log");
    expect(plist).not.toContain("node_modules/t3");
    expect(plist).not.toContain("npm");
    expect(plist).not.toContain("npx");
    expect(plist).not.toContain("--disable-gpu");
    const supervisorSource = NodeFS.readFileSync(supervisor.path, "utf8");
    expect(supervisorSource).toContain("validatePackagedRuntime(descriptorPath, {");
    expect(supervisorSource).toContain(
      '[runtime.serverEntryPath, "serve", "--no-browser", "--host", "127.0.0.1"]',
    );
    expect(supervisorSource).toContain("delete environment.NODE_OPTIONS");
    expect(supervisorSource).toContain("delete environment.NODE_PATH");
  });

  it("fails closed instead of replacing a modified stable supervisor", () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const supervisor = preparePackagedServerSupervisor({ runtimeRoot });
    NodeFS.chmodSync(supervisor.path, 0o600);
    NodeFS.appendFileSync(supervisor.path, "tampered");
    NodeFS.chmodSync(supervisor.path, 0o400);

    expect(() =>
      validatePackagedServerSupervisor({ runtimeRoot, sha256: supervisor.sha256 }),
    ).toThrow("checksum does not match");
    expect(() => preparePackagedServerSupervisor({ runtimeRoot })).toThrow(
      "checksum does not match",
    );
  });

  it("refuses a tampered supervisor at the actual launch bootstrap boundary", async () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const markerPath = NodePath.join(root, "tampered-supervisor-executed");
    const sourcePath = NodePath.join(root, "supervisor.mjs");
    NodeFS.writeFileSync(
      sourcePath,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "executed");\n`,
    );
    const supervisor = preparePackagedServerSupervisor({ runtimeRoot, sourcePath });
    const runtime = preparePackagedServerRuntime({
      buildManifestPath: writeBuildManifest(root),
      sourceAppPath: await createPackagedApp(root),
      runtimeRoot,
      inspection: inspection(),
    });
    const plan = createPackagedServerServicePlan({
      homeDir: NodeOS.homedir(),
      nodePath: process.execPath,
      supervisor,
      runtime,
    });
    const programArguments = programArgumentsFromPlist(renderPackagedServerLaunchAgent(plan));
    NodeFS.chmodSync(supervisor.path, 0o600);
    NodeFS.writeFileSync(
      supervisor.path,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "tampered");\n`,
    );
    NodeFS.chmodSync(supervisor.path, 0o400);

    const [command, ...args] = programArguments;
    if (command === undefined) throw new Error("Rendered LaunchAgent has no command.");
    const result = NodeChildProcess.spawnSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Packaged supervisor integrity check failed");
    expect(NodeFS.existsSync(markerPath)).toBe(false);
  });

  it("rejects a managed launcher that is inside the candidate", async () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const runtime = preparePackagedServerRuntime({
      buildManifestPath: writeBuildManifest(root),
      sourceAppPath: await createPackagedApp(root),
      runtimeRoot,
      inspection: inspection(),
    });
    const supervisor = preparePackagedServerSupervisor({ runtimeRoot });

    expect(() =>
      createPackagedServerServicePlan({
        homeDir: "/Users/lastcode",
        nodePath: runtime.executablePath,
        supervisor,
        runtime,
      }),
    ).toThrow("Node executable must be an absolute path outside the candidate");
  });

  it("rejects an external Node path that resolves into the candidate", async () => {
    const root = temporaryDirectory();
    const runtimeRoot = NodePath.join(root, "runtime", "packaged-server");
    const runtime = preparePackagedServerRuntime({
      buildManifestPath: writeBuildManifest(root),
      sourceAppPath: await createPackagedApp(root),
      runtimeRoot,
      inspection: inspection(),
    });
    const supervisor = preparePackagedServerSupervisor({ runtimeRoot });
    const nodeSymlink = NodePath.join(root, "managed-node");
    NodeFS.symlinkSync(runtime.executablePath, nodeSymlink);

    expect(() =>
      createPackagedServerServicePlan({
        homeDir: "/Users/lastcode",
        nodePath: nodeSymlink,
        supervisor,
        runtime,
      }),
    ).toThrow("Node executable must be an absolute path outside the candidate");
  });
});
