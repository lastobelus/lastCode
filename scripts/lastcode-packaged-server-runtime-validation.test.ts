// @effect-diagnostics nodeBuiltinImport:off
import { createPackage } from "@electron/asar";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR,
  LASTCODE_PACKAGED_RUNTIME_SENTINEL,
  validatePackagedServerRuntime,
  type PackagedAppInspection,
  type PackagedServerRuntimeDescriptor,
  type PackagedServerRuntimeIdentity,
} from "./lib/lastcode-packaged-server-runtime.ts";

const identity: PackagedServerRuntimeIdentity = {
  product: "LastCode",
  version: "1.2.3",
  tag: "lastcode/checkpoint/v1.2.3",
  buildTag: "lastcode/build/v1.2.3.1",
  commit: "a".repeat(40),
  platform: "darwin",
  arch: "x64",
  bundleId: "codes.lastobelus.lastcode",
};
const serverVersion = "1.2.0";
const mismatch = "Packaged runtime payload checksums do not match its descriptor.";
const mutableFS = NodeModule.createRequire(import.meta.url)("node:fs") as typeof NodeFS;
const directories: string[] = [];
const inspectionOrder = [
  "CFBundleIdentifier",
  "CFBundleShortVersionString",
  "architectures",
  "signature",
  "version",
];
const hash = (bytes: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "synthetic-validator-only-"));
  directories.push(root);
  const versionDir = NodePath.join(root, "versions", "1.2.3-aaaaaaaaaaaa-build-1");
  const applicationPath = NodePath.join(versionDir, "LastCode.app");
  const executablePath = NodePath.join(applicationPath, "Contents", "MacOS", "LastCode");
  const appAsarPath = NodePath.join(applicationPath, "Contents", "Resources", "app.asar");
  const source = NodePath.join(root, "synthetic-asar-data");
  NodeFS.mkdirSync(NodePath.dirname(executablePath), { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(appAsarPath), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(source, "apps", "server", "dist"), { recursive: true });
  // These bytes are inert fixture data, never an executable or a server invocation.
  const executable = "synthetic non-executable data";
  const entry = "synthetic server entry data — λ";
  NodeFS.writeFileSync(executablePath, executable, { mode: 0o600 });
  NodeFS.writeFileSync(NodePath.join(source, "apps", "server", "dist", "bin.mjs"), entry);
  NodeFS.writeFileSync(
    NodePath.join(source, "package.json"),
    JSON.stringify({
      name: "lastcode",
      version: "1.2.3",
      buildVersion: "1.2.3",
      t3codeCommitHash: "aaaaaaaaaaaa",
    }),
  );
  await createPackage(source, appAsarPath);
  const descriptorPath = NodePath.join(versionDir, LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR);
  const sentinelPath = NodePath.join(versionDir, LASTCODE_PACKAGED_RUNTIME_SENTINEL);
  const descriptor: PackagedServerRuntimeDescriptor = {
    schemaVersion: 1,
    ...identity,
    application: "LastCode.app",
    executable: "LastCode.app/Contents/MacOS/LastCode",
    appAsar: "LastCode.app/Contents/Resources/app.asar",
    serverEntry: "LastCode.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    serverVersion,
    checksums: {
      executableSha256: hash(executable),
      appAsarSha256: hash(NodeFS.readFileSync(appAsarPath)),
      serverEntrySha256: hash(entry),
    },
  };
  const writeDescriptor = (value: unknown) => {
    const raw = JSON.stringify(value);
    NodeFS.writeFileSync(descriptorPath, raw);
    NodeFS.writeFileSync(
      sentinelPath,
      JSON.stringify({ schemaVersion: 1, descriptorSha256: hash(raw) }),
    );
  };
  writeDescriptor(descriptor);
  const trace: string[] = [];
  const inspection: PackagedAppInspection = {
    readBundleValue: (path, key) => {
      expect(path).toBe(applicationPath);
      trace.push(key);
      return key === "CFBundleIdentifier" ? identity.bundleId : identity.version;
    },
    readArchitectures: (path) => {
      expect(path).toBe(executablePath);
      trace.push("architectures");
      return ["x86_64"];
    },
    verifyCodeSignature: (path) => {
      expect(path).toBe(applicationPath);
      trace.push("signature");
    },
    probeServerVersion: (path, entryPath) => {
      expect(path).toBe(executablePath);
      expect(entryPath).toBe(NodePath.join(appAsarPath, "apps/server/dist/bin.mjs"));
      trace.push("version");
      return `synthetic v${serverVersion}`;
    },
  };
  return {
    root,
    versionDir,
    applicationPath,
    executablePath,
    appAsarPath,
    descriptorPath,
    sentinelPath,
    descriptor,
    trace,
    inspection,
    writeDescriptor,
    validate: () => validatePackagedServerRuntime({ runtimeRoot: root, identity, inspection }),
  };
}

it("validates real synthetic file/decode/archive/hash data and returns the branded paths", async () => {
  const f = await fixture();
  const result = f.validate();
  expect(result.descriptor).toEqual(f.descriptor);
  expect(result).toMatchObject({
    versionDir: f.versionDir,
    descriptorPath: f.descriptorPath,
    sentinelPath: f.sentinelPath,
    applicationPath: f.applicationPath,
    executablePath: f.executablePath,
    appAsarPath: f.appAsarPath,
    serverEntryPath: NodePath.join(f.appAsarPath, "apps/server/dist/bin.mjs"),
    descriptorSha256: hash(NodeFS.readFileSync(f.descriptorPath)),
  });
  const symbols = Object.getOwnPropertySymbols(result);
  expect(symbols).toHaveLength(1);
  expect(symbols[0]?.description).toBe("LastCodeValidatedPackagedRuntime");
  expect(Reflect.get(result, symbols[0]!)).toBe(true);
  expect(f.trace).toEqual(inspectionOrder);
});

it.each(Array.from({ length: 15 }, (_, index) => index + 1))(
  "rejects exactly the payload error for mismatch mask %i",
  async (mask) => {
    const f = await fixture();
    f.writeDescriptor({
      ...f.descriptor,
      serverVersion: mask & 1 ? "9.9.9" : f.descriptor.serverVersion,
      checksums: {
        executableSha256: mask & 2 ? "b".repeat(64) : f.descriptor.checksums.executableSha256,
        appAsarSha256: mask & 4 ? "b".repeat(64) : f.descriptor.checksums.appAsarSha256,
        serverEntrySha256: mask & 8 ? "b".repeat(64) : f.descriptor.checksums.serverEntrySha256,
      },
    });
    expect(f.validate).toThrowError(new Error(mismatch));
    expect(f.trace).toEqual(inspectionOrder);
    expect(NodeFS.readFileSync(f.executablePath, "utf8")).toBe("synthetic non-executable data");
    expect(NodeFS.readdirSync(f.versionDir).sort()).toEqual(
      [
        LASTCODE_PACKAGED_RUNTIME_SENTINEL,
        "LastCode.app",
        LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR,
      ].sort(),
    );
  },
);

it("rejects descriptor identity before missing sentinel or inspection", async () => {
  const f = await fixture();
  f.writeDescriptor({ ...f.descriptor, commit: "b".repeat(40) });
  NodeFS.unlinkSync(f.sentinelPath);
  expect(f.validate).toThrowError(
    new Error(`Packaged runtime descriptor identity does not match ${identity.tag}.`),
  );
  expect(f.trace).toEqual([]);
});

it("rejects malformed descriptor JSON before sentinel and inspection", async () => {
  const f = await fixture();
  NodeFS.writeFileSync(f.descriptorPath, "{");
  expect(f.validate).toThrowError(SyntaxError);
  expect(f.trace).toEqual([]);
});

it("rejects descriptor schema errors before sentinel and inspection", async () => {
  const f = await fixture();
  f.writeDescriptor({ ...f.descriptor, checksums: { executableSha256: "invalid" } });
  expect(f.validate).toThrow();
  expect(f.trace).toEqual([]);
});

it("rejects invalid sentinel JSON before inspection", async () => {
  const f = await fixture();
  NodeFS.writeFileSync(f.sentinelPath, "{");
  expect(f.validate).toThrowError(
    new Error(`Could not read packaged runtime completion sentinel at ${f.sentinelPath}.`),
  );
  expect(f.trace).toEqual([]);
});

it("rejects invalid sentinel schema before inspection", async () => {
  const f = await fixture();
  NodeFS.writeFileSync(f.sentinelPath, JSON.stringify({ schemaVersion: 2 }));
  expect(f.validate).toThrowError(
    new Error(`Invalid packaged runtime completion sentinel at ${f.sentinelPath}.`),
  );
  expect(f.trace).toEqual([]);
});

it("rejects sentinel mismatch before inspection", async () => {
  const f = await fixture();
  NodeFS.writeFileSync(
    f.sentinelPath,
    JSON.stringify({ schemaVersion: 1, descriptorSha256: "0".repeat(64) }),
  );
  expect(f.validate).toThrowError(
    new Error("Packaged runtime completion sentinel does not match its descriptor."),
  );
  expect(f.trace).toEqual([]);
});

it.each([false, true])(
  "preserves native descriptor/sentinel/inspection/hash order (mismatch=%s)",
  async (different) => {
    const f = await fixture();
    if (different) f.writeDescriptor({ ...f.descriptor, serverVersion: "9.9.9" });
    const readFile = NodeFS.readFileSync;
    const open = NodeFS.openSync;
    const trace: string[] = [];
    vi.spyOn(mutableFS, "readFileSync").mockImplementation(
      (...args: Parameters<typeof NodeFS.readFileSync>) => {
        if (args[0] === f.descriptorPath) trace.push("descriptor");
        if (args[0] === f.sentinelPath) trace.push("sentinel");
        return readFile(...args);
      },
    );
    vi.spyOn(mutableFS, "openSync").mockImplementation((...args) => {
      if (args[0] === f.executablePath) trace.push("hash executable");
      if (args[0] === f.appAsarPath) trace.push("hash archive");
      return open(...args);
    });
    NodeModule.syncBuiltinESMExports();
    const callbacks = f.inspection;
    const inspection: PackagedAppInspection = {
      readBundleValue: (path, key) => {
        trace.push(key);
        return callbacks.readBundleValue(path, key);
      },
      readArchitectures: (path) => {
        trace.push("architectures");
        return callbacks.readArchitectures(path);
      },
      verifyCodeSignature: (path) => {
        trace.push("signature");
        callbacks.verifyCodeSignature(path);
      },
      probeServerVersion: (path, entry) => {
        trace.push("version");
        return callbacks.probeServerVersion(path, entry);
      },
    };
    const validate = () =>
      validatePackagedServerRuntime({ runtimeRoot: f.root, identity, inspection });
    if (different) expect(validate).toThrowError(new Error(mismatch));
    else expect(validate().descriptor).toEqual(f.descriptor);
    // ASAR extraction opens the archive too; only the two opens after version are hashing.
    expect(trace.slice(0, 6)).toEqual([
      "descriptor",
      "sentinel",
      "CFBundleIdentifier",
      "CFBundleShortVersionString",
      "architectures",
      "signature",
    ]);
    expect(trace.slice(trace.indexOf("version"))).toEqual([
      "version",
      "hash executable",
      "hash archive",
    ]);
  },
);
