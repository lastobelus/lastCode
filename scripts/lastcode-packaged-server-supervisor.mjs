#!/usr/bin/env node
// LastCode managed supervisor: packaged server runtime

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const PRODUCT = "LastCode";
const ARCH = "x64";
const BUNDLE_ID = "codes.lastobelus.lastcode";
const APP_DIRECTORY = "LastCode.app";
const EXECUTABLE_PATH = "LastCode.app/Contents/MacOS/LastCode";
const APP_ASAR_PATH = "LastCode.app/Contents/Resources/app.asar";
const SERVER_ENTRY_PATH = "LastCode.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";
const SENTINEL_PATH = ".lastcode-packaged-runtime-complete.json";
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const IDENTITY_PROBE = `
const crypto = await import("node:crypto");
const fs = await import("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const serverEntry = fs.readFileSync(process.argv[2]);
process.stdout.write(JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  buildVersion: manifest.buildVersion,
  commit: manifest.t3codeCommitHash,
  serverEntrySha256: crypto.createHash("sha256").update(serverEntry).digest("hex")
}));
`;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path, label) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Could not read ${label} at ${path}.`, { cause });
  }
}

function hashFile(path) {
  const hash = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = NodeFS.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    NodeFS.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function hashString(value) {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function runChecked(command, args, environment) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    ...(environment === undefined ? {} : { env: environment }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${command} failed with exit ${result.status}.`,
    );
  }
  return result.stdout.trim();
}

function decodeDescriptor(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.product !== PRODUCT ||
    typeof value.version !== "string" ||
    !EXACT_VERSION_PATTERN.test(value.version) ||
    typeof value.serverVersion !== "string" ||
    !EXACT_VERSION_PATTERN.test(value.serverVersion) ||
    typeof value.tag !== "string" ||
    !value.tag.startsWith("lastcode/") ||
    typeof value.buildTag !== "string" ||
    !value.buildTag.startsWith("lastcode/build/") ||
    typeof value.commit !== "string" ||
    !SHA1_PATTERN.test(value.commit) ||
    value.platform !== "darwin" ||
    value.arch !== ARCH ||
    value.bundleId !== BUNDLE_ID ||
    value.application !== APP_DIRECTORY ||
    value.executable !== EXECUTABLE_PATH ||
    value.appAsar !== APP_ASAR_PATH ||
    value.serverEntry !== SERVER_ENTRY_PATH ||
    !isRecord(value.checksums) ||
    !SHA256_PATTERN.test(value.checksums.executableSha256) ||
    !SHA256_PATTERN.test(value.checksums.appAsarSha256) ||
    !SHA256_PATTERN.test(value.checksums.serverEntrySha256)
  ) {
    fail("Packaged LastCode runtime descriptor is invalid or unsupported.");
  }
  const tagMatch = /^lastcode\/(?:checkpoint|revision)\/v(.+)$/.exec(value.tag);
  const buildTagPrefix = `lastcode/build/v${value.version}.`;
  const buildNumber = value.buildTag.startsWith(buildTagPrefix)
    ? value.buildTag.slice(buildTagPrefix.length)
    : "";
  if (tagMatch?.[1] !== value.version || !/^[1-9]\d*$/.test(buildNumber)) {
    fail("Packaged LastCode runtime tags do not match its version.");
  }
  return value;
}

export function validatePackagedRuntime(descriptorPath, expected) {
  const versionDir = NodePath.dirname(NodePath.resolve(descriptorPath));
  const rawDescriptor = NodeFS.readFileSync(descriptorPath, "utf8");
  if (
    !isRecord(expected) ||
    NodePath.resolve(expected.descriptorPath ?? "") !== NodePath.resolve(descriptorPath) ||
    !SHA256_PATTERN.test(expected.descriptorSha256 ?? "") ||
    expected.descriptorSha256 !== hashString(rawDescriptor)
  ) {
    fail("Packaged LastCode runtime does not match the LaunchAgent descriptor pin.");
  }
  const descriptor = decodeDescriptor(JSON.parse(rawDescriptor));
  if (
    descriptor.version !== expected.version ||
    descriptor.tag !== expected.tag ||
    descriptor.buildTag !== expected.buildTag ||
    descriptor.commit !== expected.commit
  ) {
    fail("Packaged LastCode runtime identity does not match the LaunchAgent pin.");
  }
  const sentinel = readJson(
    NodePath.join(versionDir, SENTINEL_PATH),
    "runtime completion sentinel",
  );
  if (
    !isRecord(sentinel) ||
    sentinel.schemaVersion !== 1 ||
    sentinel.descriptorSha256 !== hashString(rawDescriptor)
  ) {
    fail("Packaged LastCode runtime completion sentinel does not match its descriptor.");
  }
  const executablePath = NodePath.join(versionDir, ...descriptor.executable.split("/"));
  const appAsarPath = NodePath.join(versionDir, ...descriptor.appAsar.split("/"));
  const serverEntryPath = NodePath.join(versionDir, ...descriptor.serverEntry.split("/"));
  if (
    hashFile(executablePath) !== descriptor.checksums.executableSha256 ||
    hashFile(appAsarPath) !== descriptor.checksums.appAsarSha256
  ) {
    fail("Packaged LastCode runtime payload checksums do not match its descriptor.");
  }
  const appPath = NodePath.join(versionDir, descriptor.application);
  const bundleId = runChecked("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    NodePath.join(appPath, "Contents", "Info.plist"),
  ]);
  const bundleVersion = runChecked("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    NodePath.join(appPath, "Contents", "Info.plist"),
  ]);
  const architectures = runChecked("/usr/bin/lipo", ["-archs", executablePath])
    .split(/\s+/)
    .filter(Boolean)
    .map((architecture) => (architecture === "x86_64" ? "x64" : architecture));
  if (bundleId !== BUNDLE_ID || bundleVersion !== descriptor.version) {
    fail("Packaged LastCode bundle identity does not match its runtime descriptor.");
  }
  if (architectures.length !== 1 || architectures[0] !== ARCH) {
    fail("Packaged LastCode runtime is not an exact x64 executable.");
  }
  runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const packagedIdentity = readJsonFromOutput(
    runChecked(
      executablePath,
      [
        "--no-global-search-paths",
        "--input-type=module",
        "--eval",
        IDENTITY_PROBE,
        NodePath.join(appAsarPath, "package.json"),
        serverEntryPath,
      ],
      { ...environment, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" },
    ),
    "packaged identity probe",
  );
  if (
    !isRecord(packagedIdentity) ||
    packagedIdentity.name !== "lastcode" ||
    packagedIdentity.version !== descriptor.version ||
    packagedIdentity.buildVersion !== descriptor.version ||
    packagedIdentity.commit !== descriptor.commit.slice(0, 12) ||
    packagedIdentity.serverEntrySha256 !== descriptor.checksums.serverEntrySha256
  ) {
    fail("Packaged LastCode embedded identity does not match its runtime descriptor.");
  }
  const versionOutput = runChecked(executablePath, [serverEntryPath, "--version"], {
    ...environment,
    ELECTRON_RUN_AS_NODE: "1",
  });
  const serverVersion = /\bv(\S+)\s*$/.exec(versionOutput)?.[1];
  if (serverVersion !== descriptor.serverVersion) {
    fail("Packaged LastCode server preflight disagrees with its runtime descriptor.");
  }
  return { descriptor, executablePath, serverEntryPath };
}

function readJsonFromOutput(value, label) {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(`Could not decode ${label}.`, { cause });
  }
}

async function supervise(descriptorPath) {
  const runtime = validatePackagedRuntime(descriptorPath, {
    descriptorPath: process.env.LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR,
    descriptorSha256: process.env.LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR_SHA256,
    version: process.env.LASTCODE_PACKAGED_RUNTIME_VERSION,
    tag: process.env.LASTCODE_PACKAGED_RUNTIME_TAG,
    buildTag: process.env.LASTCODE_PACKAGED_RUNTIME_BUILD_TAG,
    commit: process.env.LASTCODE_PACKAGED_RUNTIME_COMMIT,
  });
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const child = NodeChildProcess.spawn(
    runtime.executablePath,
    [runtime.serverEntryPath, "serve", "--no-browser", "--host", "127.0.0.1"],
    {
      env: environment,
      stdio: "inherit",
    },
  );
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onSigterm = () => forward("SIGTERM");
  const onSigint = () => forward("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  try {
    const result = await completion;
    if (result.signal !== null) process.kill(process.pid, result.signal);
    process.exitCode = result.code ?? 1;
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isMain) {
  const descriptorPath = process.argv[2];
  if (!descriptorPath) {
    process.stderr.write("[lastcode-server-supervisor] Missing runtime descriptor path.\n");
    process.exitCode = 1;
  } else {
    supervise(descriptorPath).catch((cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      process.stderr.write(`[lastcode-server-supervisor] ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
