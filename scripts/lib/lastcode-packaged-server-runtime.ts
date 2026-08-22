// @effect-diagnostics nodeBuiltinImport:off globalProcess:off
// LastCode managed module: packaged server runtime

import { extractFile } from "@electron/asar";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import {
  parseLastCodeInstallableTag,
  versionFromLastCodeInstallableTag,
} from "../lastcode-nightly.ts";

export const LASTCODE_PACKAGED_RUNTIME_PRODUCT = "LastCode" as const;
export const LASTCODE_PACKAGED_RUNTIME_ARCH = "x64" as const;
export const LASTCODE_PACKAGED_RUNTIME_BUNDLE_ID = "codes.lastobelus.lastcode" as const;
export const LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR = "lastcode-packaged-runtime.json" as const;
export const LASTCODE_PACKAGED_RUNTIME_SENTINEL =
  ".lastcode-packaged-runtime-complete.json" as const;

const APP_DIRECTORY = "LastCode.app" as const;
const EXECUTABLE_PATH = "LastCode.app/Contents/MacOS/LastCode" as const;
const APP_ASAR_PATH = "LastCode.app/Contents/Resources/app.asar" as const;
const SERVER_ENTRY_PATH =
  "LastCode.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs" as const;
const SERVER_ENTRY_ASAR_PATH = "apps/server/dist/bin.mjs" as const;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHORT_COMMIT_PATTERN = /^[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const Sha1 = Schema.String.check(Schema.isPattern(SHA1_PATTERN));
const ShortCommit = Schema.String.check(Schema.isPattern(SHORT_COMMIT_PATTERN));
const Sha256 = Schema.String.check(Schema.isPattern(SHA256_PATTERN));

const BuildManifestIdentity = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  arch: Schema.Literal(LASTCODE_PACKAGED_RUNTIME_ARCH),
  buildTag: Schema.String,
  checkpointTag: Schema.String,
  lastCodeCommit: Sha1,
  platform: Schema.Literal("mac"),
});

const PackagedAppManifest = Schema.Struct({
  name: Schema.Literal("lastcode"),
  version: Schema.String,
  buildVersion: Schema.String,
  t3codeCommitHash: ShortCommit,
});

export const PackagedServerRuntimeDescriptor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  product: Schema.Literal(LASTCODE_PACKAGED_RUNTIME_PRODUCT),
  version: Schema.String.check(Schema.isPattern(EXACT_VERSION_PATTERN)),
  tag: Schema.String,
  buildTag: Schema.String,
  commit: Sha1,
  platform: Schema.Literal("darwin"),
  arch: Schema.Literal(LASTCODE_PACKAGED_RUNTIME_ARCH),
  bundleId: Schema.Literal(LASTCODE_PACKAGED_RUNTIME_BUNDLE_ID),
  application: Schema.Literal(APP_DIRECTORY),
  executable: Schema.Literal(EXECUTABLE_PATH),
  appAsar: Schema.Literal(APP_ASAR_PATH),
  serverEntry: Schema.Literal(SERVER_ENTRY_PATH),
  serverVersion: Schema.String.check(Schema.isPattern(EXACT_VERSION_PATTERN)),
  checksums: Schema.Struct({
    executableSha256: Sha256,
    appAsarSha256: Sha256,
    serverEntrySha256: Sha256,
  }),
});

const PackagedServerRuntimeSentinel = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  descriptorSha256: Sha256,
});
const decodeBuildManifestIdentity = Schema.decodeUnknownSync(BuildManifestIdentity);
const decodePackagedAppManifest = Schema.decodeUnknownSync(PackagedAppManifest);
const decodePackagedServerRuntimeDescriptor = Schema.decodeUnknownSync(
  PackagedServerRuntimeDescriptor,
);
const decodePackagedServerRuntimeSentinel = Schema.decodeUnknownSync(PackagedServerRuntimeSentinel);

export type PackagedServerRuntimeIdentity = {
  readonly product: typeof LASTCODE_PACKAGED_RUNTIME_PRODUCT;
  readonly version: string;
  readonly tag: string;
  readonly buildTag: string;
  readonly commit: string;
  readonly platform: "darwin";
  readonly arch: typeof LASTCODE_PACKAGED_RUNTIME_ARCH;
  readonly bundleId: typeof LASTCODE_PACKAGED_RUNTIME_BUNDLE_ID;
};

export type PackagedServerRuntimeDescriptor = typeof PackagedServerRuntimeDescriptor.Type;

const validatedRuntime = Symbol("LastCodeValidatedPackagedRuntime");

export type ValidatedPackagedServerRuntime = {
  readonly [validatedRuntime]: true;
  readonly versionDir: string;
  readonly descriptorPath: string;
  readonly sentinelPath: string;
  readonly applicationPath: string;
  readonly executablePath: string;
  readonly appAsarPath: string;
  readonly serverEntryPath: string;
  readonly descriptorSha256: string;
  readonly descriptor: PackagedServerRuntimeDescriptor;
};

export interface PackagedAppInspection {
  readonly readBundleValue: (appPath: string, key: string) => string;
  readonly readArchitectures: (executablePath: string) => ReadonlyArray<string>;
  readonly verifyCodeSignature: (appPath: string) => void;
  readonly probeServerVersion: (executablePath: string, serverEntryPath: string) => string;
}

export interface PreparePackagedServerRuntimeInput {
  readonly buildManifestPath: string;
  readonly sourceAppPath: string;
  readonly runtimeRoot: string;
  readonly inspection?: PackagedAppInspection;
}

function decodeJsonFile<A>(path: string, decode: (input: unknown) => A, label: string): A {
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Could not read ${label} at ${path}.`, { cause });
  }
  try {
    return decode(parsed);
  } catch (cause) {
    throw new Error(`Invalid ${label} at ${path}.`, { cause });
  }
}

function sha256(value: NodeJS.ArrayBufferView | string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(path: string): string {
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

function assertFile(path: string, label: string): void {
  if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} is missing at ${path}.`);
  }
}

function assertContainedSymlinks(appPath: string): void {
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolvedTarget = NodePath.resolve(
          NodePath.dirname(entryPath),
          NodeFS.readlinkSync(entryPath),
        );
        const relativeTarget = NodePath.relative(appPath, resolvedTarget);
        if (
          relativeTarget === "" ||
          (relativeTarget !== ".." &&
            !relativeTarget.startsWith(`..${NodePath.sep}`) &&
            !NodePath.isAbsolute(relativeTarget))
        ) {
          continue;
        }
        throw new Error(
          `Packaged LastCode contains a symlink outside its application bundle: ${entryPath}.`,
        );
      }
      if (entry.isDirectory()) walk(entryPath);
    }
  };
  walk(appPath);
}

function runChecked(command: string, args: ReadonlyArray<string>, environment?: NodeJS.ProcessEnv) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    ...(environment === undefined ? {} : { env: environment }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${command} failed with exit ${result.status}.`,
    );
  }
  return result.stdout.trim();
}

export const defaultPackagedAppInspection: PackagedAppInspection = {
  readBundleValue: (appPath, key) =>
    runChecked("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      "-o",
      "-",
      NodePath.join(appPath, "Contents", "Info.plist"),
    ]),
  readArchitectures: (executablePath) =>
    runChecked("/usr/bin/lipo", ["-archs", executablePath]).split(/\s+/).filter(Boolean),
  verifyCodeSignature: (appPath) => {
    runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  },
  probeServerVersion: (executablePath, serverEntryPath) => {
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    return runChecked(executablePath, [serverEntryPath, "--version"], {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
    });
  },
};

export function readPackagedServerRuntimeIdentity(
  buildManifestPath: string,
): PackagedServerRuntimeIdentity {
  const manifest = decodeJsonFile(
    buildManifestPath,
    decodeBuildManifestIdentity,
    "LastCode build manifest",
  );
  const installable = parseLastCodeInstallableTag(manifest.checkpointTag);
  if (!installable) {
    throw new Error(`Build manifest has invalid LastCode tag '${manifest.checkpointTag}'.`);
  }
  const version = versionFromLastCodeInstallableTag(manifest.checkpointTag);
  const buildTagPrefix = `lastcode/build/v${version}.`;
  const buildNumber = manifest.buildTag.startsWith(buildTagPrefix)
    ? manifest.buildTag.slice(buildTagPrefix.length)
    : "";
  if (!/^[1-9]\d*$/.test(buildNumber)) {
    throw new Error(
      `Build manifest tag '${manifest.buildTag}' does not belong to ${manifest.checkpointTag}.`,
    );
  }
  return {
    product: LASTCODE_PACKAGED_RUNTIME_PRODUCT,
    version,
    tag: manifest.checkpointTag,
    buildTag: manifest.buildTag,
    commit: manifest.lastCodeCommit,
    platform: "darwin",
    arch: LASTCODE_PACKAGED_RUNTIME_ARCH,
    bundleId: LASTCODE_PACKAGED_RUNTIME_BUNDLE_ID,
  };
}

function runtimePaths(runtimeRoot: string, identity: PackagedServerRuntimeIdentity) {
  const buildNumber = identity.buildTag.slice(identity.buildTag.lastIndexOf(".") + 1);
  const versionDir = NodePath.join(
    runtimeRoot,
    "versions",
    `${identity.version}-${identity.commit.slice(0, 12)}-build-${buildNumber}`,
  );
  return {
    versionDir,
    descriptorPath: NodePath.join(versionDir, LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR),
    sentinelPath: NodePath.join(versionDir, LASTCODE_PACKAGED_RUNTIME_SENTINEL),
    applicationPath: NodePath.join(versionDir, APP_DIRECTORY),
    executablePath: NodePath.join(versionDir, ...EXECUTABLE_PATH.split("/")),
    appAsarPath: NodePath.join(versionDir, ...APP_ASAR_PATH.split("/")),
    serverEntryPath: NodePath.join(versionDir, ...SERVER_ENTRY_PATH.split("/")),
  };
}

function inspectPackagedApp(
  appPath: string,
  identity: PackagedServerRuntimeIdentity,
  inspection: PackagedAppInspection,
) {
  const executablePath = NodePath.join(appPath, "Contents", "MacOS", "LastCode");
  const appAsarPath = NodePath.join(appPath, "Contents", "Resources", "app.asar");
  const serverEntryPath = NodePath.join(appAsarPath, ...SERVER_ENTRY_ASAR_PATH.split("/"));
  assertFile(executablePath, "Packaged LastCode executable");
  assertFile(appAsarPath, "Packaged LastCode app.asar");
  assertContainedSymlinks(appPath);

  const bundleId = inspection.readBundleValue(appPath, "CFBundleIdentifier");
  if (bundleId !== identity.bundleId) {
    throw new Error(`Expected LastCode bundle ${identity.bundleId}, found ${bundleId}.`);
  }
  const bundleVersion = inspection.readBundleValue(appPath, "CFBundleShortVersionString");
  if (bundleVersion !== identity.version) {
    throw new Error(`Expected LastCode version ${identity.version}, found ${bundleVersion}.`);
  }
  const architectures = inspection
    .readArchitectures(executablePath)
    .map((architecture) => (architecture === "x86_64" ? "x64" : architecture));
  if (architectures.length !== 1 || architectures[0] !== identity.arch) {
    throw new Error(
      `Expected an exact ${identity.arch} LastCode runtime, found ${architectures.join(", ") || "no architecture"}.`,
    );
  }
  inspection.verifyCodeSignature(appPath);

  let packagedManifest: typeof PackagedAppManifest.Type;
  let serverEntry: Buffer;
  try {
    packagedManifest = decodePackagedAppManifest(
      JSON.parse(extractFile(appAsarPath, "package.json").toString("utf8")) as unknown,
    );
    serverEntry = extractFile(appAsarPath, SERVER_ENTRY_ASAR_PATH);
  } catch (cause) {
    throw new Error("The packaged LastCode app has an invalid or missing server payload.", {
      cause,
    });
  }
  if (
    packagedManifest.version !== identity.version ||
    packagedManifest.buildVersion !== identity.version
  ) {
    throw new Error(
      `Packaged server version does not match ${identity.version} (${packagedManifest.version}/${packagedManifest.buildVersion}).`,
    );
  }
  if (packagedManifest.t3codeCommitHash !== identity.commit.slice(0, 12)) {
    throw new Error(
      `Packaged server commit ${packagedManifest.t3codeCommitHash} does not match ${identity.commit}.`,
    );
  }
  const versionOutput = inspection.probeServerVersion(executablePath, serverEntryPath);
  const reportedVersion = /\bv(\S+)\s*$/.exec(versionOutput)?.[1];
  if (reportedVersion === undefined || !EXACT_VERSION_PATTERN.test(reportedVersion)) {
    throw new Error(
      `Packaged server preflight reported no valid version${reportedVersion === undefined ? "" : ` (${reportedVersion})`}.`,
    );
  }

  return {
    serverVersion: reportedVersion,
    executableSha256: hashFile(executablePath),
    appAsarSha256: hashFile(appAsarPath),
    serverEntrySha256: sha256(serverEntry),
  };
}

function descriptorIdentityMatches(
  descriptor: PackagedServerRuntimeDescriptor,
  identity: PackagedServerRuntimeIdentity,
): boolean {
  return (
    descriptor.product === identity.product &&
    descriptor.version === identity.version &&
    descriptor.tag === identity.tag &&
    descriptor.buildTag === identity.buildTag &&
    descriptor.commit === identity.commit &&
    descriptor.platform === identity.platform &&
    descriptor.arch === identity.arch &&
    descriptor.bundleId === identity.bundleId
  );
}

export function validatePackagedServerRuntime(input: {
  readonly runtimeRoot: string;
  readonly identity: PackagedServerRuntimeIdentity;
  readonly inspection?: PackagedAppInspection;
}): ValidatedPackagedServerRuntime {
  const paths = runtimePaths(input.runtimeRoot, input.identity);
  const rawDescriptor = NodeFS.readFileSync(paths.descriptorPath, "utf8");
  const descriptor = decodePackagedServerRuntimeDescriptor(JSON.parse(rawDescriptor) as unknown);
  if (!descriptorIdentityMatches(descriptor, input.identity)) {
    throw new Error(`Packaged runtime descriptor identity does not match ${input.identity.tag}.`);
  }
  const sentinel = decodeJsonFile(
    paths.sentinelPath,
    decodePackagedServerRuntimeSentinel,
    "packaged runtime completion sentinel",
  );
  if (sentinel.descriptorSha256 !== sha256(rawDescriptor)) {
    throw new Error("Packaged runtime completion sentinel does not match its descriptor.");
  }
  const checksums = inspectPackagedApp(
    paths.applicationPath,
    input.identity,
    input.inspection ?? defaultPackagedAppInspection,
  );
  if (
    checksums.serverVersion !== descriptor.serverVersion ||
    checksums.executableSha256 !== descriptor.checksums.executableSha256 ||
    checksums.appAsarSha256 !== descriptor.checksums.appAsarSha256 ||
    checksums.serverEntrySha256 !== descriptor.checksums.serverEntrySha256
  ) {
    throw new Error("Packaged runtime payload checksums do not match its descriptor.");
  }
  return {
    [validatedRuntime]: true,
    ...paths,
    descriptorSha256: sha256(rawDescriptor),
    descriptor,
  };
}

function writeDurably(path: string, contents: string): void {
  const descriptor = NodeFS.openSync(path, "wx", 0o600);
  try {
    NodeFS.writeFileSync(descriptor, contents, "utf8");
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function syncTree(path: string): void {
  const stat = NodeFS.lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of NodeFS.readdirSync(path)) syncTree(NodePath.join(path, entry));
  }
  const descriptor = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

export function preparePackagedServerRuntime(
  input: PreparePackagedServerRuntimeInput,
): ValidatedPackagedServerRuntime {
  const identity = readPackagedServerRuntimeIdentity(input.buildManifestPath);
  const paths = runtimePaths(input.runtimeRoot, identity);
  const inspection = input.inspection ?? defaultPackagedAppInspection;
  if (NodeFS.existsSync(paths.versionDir)) {
    const hasDescriptor = NodeFS.statSync(paths.descriptorPath, {
      throwIfNoEntry: false,
    })?.isFile();
    const hasSentinel = NodeFS.statSync(paths.sentinelPath, { throwIfNoEntry: false })?.isFile();
    if (hasDescriptor && hasSentinel) {
      return validatePackagedServerRuntime({
        runtimeRoot: input.runtimeRoot,
        identity,
        inspection,
      });
    }
    NodeFS.rmSync(paths.versionDir, { recursive: true, force: true });
  }

  // Reject the source before copying a large app, then validate the copied
  // bytes again. The current service does not need to stop for either step.
  inspectPackagedApp(input.sourceAppPath, identity, inspection);
  const versionsDir = NodePath.dirname(paths.versionDir);
  NodeFS.mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
  const stagingDir = NodeFS.mkdtempSync(NodePath.join(versionsDir, ".staging-"));
  const stagingAppPath = NodePath.join(stagingDir, APP_DIRECTORY);
  try {
    NodeFS.cpSync(input.sourceAppPath, stagingAppPath, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const inspectionResult = inspectPackagedApp(stagingAppPath, identity, inspection);
    syncTree(stagingAppPath);
    const descriptor: PackagedServerRuntimeDescriptor = {
      schemaVersion: 1,
      ...identity,
      application: APP_DIRECTORY,
      executable: EXECUTABLE_PATH,
      appAsar: APP_ASAR_PATH,
      serverEntry: SERVER_ENTRY_PATH,
      serverVersion: inspectionResult.serverVersion,
      checksums: {
        executableSha256: inspectionResult.executableSha256,
        appAsarSha256: inspectionResult.appAsarSha256,
        serverEntrySha256: inspectionResult.serverEntrySha256,
      },
    };
    const rawDescriptor = `${JSON.stringify(descriptor, null, 2)}\n`;
    writeDurably(NodePath.join(stagingDir, LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR), rawDescriptor);
    // Written last: neither an app tree nor a descriptor alone is complete.
    writeDurably(
      NodePath.join(stagingDir, LASTCODE_PACKAGED_RUNTIME_SENTINEL),
      `${JSON.stringify({ schemaVersion: 1, descriptorSha256: sha256(rawDescriptor) }, null, 2)}\n`,
    );
    const stagingDescriptor = NodeFS.openSync(stagingDir, "r");
    try {
      NodeFS.fsyncSync(stagingDescriptor);
    } finally {
      NodeFS.closeSync(stagingDescriptor);
    }
    NodeFS.renameSync(stagingDir, paths.versionDir);
    const versionsDescriptor = NodeFS.openSync(versionsDir, "r");
    try {
      NodeFS.fsyncSync(versionsDescriptor);
    } finally {
      NodeFS.closeSync(versionsDescriptor);
    }
  } catch (cause) {
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
    throw cause;
  }
  return validatePackagedServerRuntime({ runtimeRoot: input.runtimeRoot, identity, inspection });
}
