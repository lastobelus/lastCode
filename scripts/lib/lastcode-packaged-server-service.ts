// @effect-diagnostics nodeBuiltinImport:off
// LastCode managed module: packaged server service

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ValidatedPackagedServerRuntime } from "./lastcode-packaged-server-runtime.ts";
import type { ValidatedPackagedServerSupervisor } from "./lastcode-packaged-server-supervisor.ts";

export const LASTCODE_PACKAGED_SERVER_SERVICE_LABEL = "codes.lastobelus.lastcode.server" as const;
export const LASTCODE_PACKAGED_SERVER_SERVICE_PLIST =
  `${LASTCODE_PACKAGED_SERVER_SERVICE_LABEL}.plist` as const;

const LASTCODE_PACKAGED_SERVER_BOOTSTRAP = `
void (async () => {
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const [supervisorPath, expectedSha256, descriptorPath] = process.argv.slice(1);
  if (!supervisorPath || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") || !descriptorPath) {
    throw new Error("Invalid packaged supervisor bootstrap arguments.");
  }
  const supervisorSource = fs.readFileSync(supervisorPath);
  const actualSha256 = crypto.createHash("sha256").update(supervisorSource).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Packaged supervisor integrity check failed.");
  }
  process.argv.splice(1, process.argv.length - 1, supervisorPath, descriptorPath);
  process.env.LASTCODE_PACKAGED_SUPERVISOR_BOOTSTRAP = "1";
  await import(\`data:text/javascript;base64,\${supervisorSource.toString("base64")}\`);
})().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  process.stderr.write(\`[lastcode-server-bootstrap] \${error.message}\\n\`);
  process.exitCode = 1;
});
`.trim();

export interface PackagedServerServicePlan {
  readonly label: typeof LASTCODE_PACKAGED_SERVER_SERVICE_LABEL;
  readonly unitPath: string;
  readonly logPath: string;
  readonly homeDir: string;
  readonly baseDir: string;
  readonly nodePath: string;
  readonly supervisor: ValidatedPackagedServerSupervisor;
  readonly runtime: ValidatedPackagedServerRuntime;
}

export function escapePlistText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function createPackagedServerServicePlan(input: {
  readonly homeDir: string;
  readonly baseDir?: string;
  readonly nodePath: string;
  readonly supervisor: ValidatedPackagedServerSupervisor;
  readonly runtime: ValidatedPackagedServerRuntime;
}): PackagedServerServicePlan {
  const baseDir = input.baseDir ?? NodePath.join(input.homeDir, ".lastcode");
  const canonicalCandidateDir = NodeFS.realpathSync(input.runtime.versionDir);
  const isInsideCandidate = (path: string) => {
    const canonicalPath = NodePath.toNamespacedPath(path);
    const relative = NodePath.relative(canonicalCandidateDir, canonicalPath);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  };
  if (!NodePath.isAbsolute(input.nodePath)) {
    throw new Error("The managed Node executable must be an absolute path outside the candidate.");
  }
  if (!NodePath.isAbsolute(input.supervisor.path)) {
    throw new Error("The managed LastCode supervisor must be outside the candidate.");
  }
  let canonicalNodePath: string;
  let canonicalSupervisorPath: string;
  try {
    canonicalNodePath = NodeFS.realpathSync(input.nodePath);
    canonicalSupervisorPath = NodeFS.realpathSync(input.supervisor.path);
  } catch (cause) {
    throw new Error("Could not resolve the managed LastCode launcher paths.", { cause });
  }
  if (isInsideCandidate(canonicalNodePath)) {
    throw new Error("The managed Node executable must be an absolute path outside the candidate.");
  }
  if (isInsideCandidate(canonicalSupervisorPath)) {
    throw new Error("The managed LastCode supervisor must be outside the candidate.");
  }
  return {
    label: LASTCODE_PACKAGED_SERVER_SERVICE_LABEL,
    unitPath: NodePath.join(
      input.homeDir,
      "Library",
      "LaunchAgents",
      LASTCODE_PACKAGED_SERVER_SERVICE_PLIST,
    ),
    logPath: NodePath.join(baseDir, "userdata", "logs", "packaged-server-service.log"),
    homeDir: input.homeDir,
    baseDir,
    nodePath: canonicalNodePath,
    supervisor: { ...input.supervisor, path: canonicalSupervisorPath },
    runtime: input.runtime,
  };
}

export function packagedServerProgramArguments(plan: PackagedServerServicePlan) {
  return [
    plan.nodePath,
    "--no-global-search-paths",
    "-e",
    LASTCODE_PACKAGED_SERVER_BOOTSTRAP,
    plan.supervisor.path,
    plan.supervisor.sha256,
    plan.runtime.descriptorPath,
  ] as const;
}

/**
 * Renders a prepared candidate only. The caller must keep the current service
 * running until the runtime has validated and this complete plist exists;
 * pending-DMG activation and launchctl handoff are deliberately separate.
 */
export function renderPackagedServerLaunchAgent(plan: PackagedServerServicePlan): string {
  const environmentPath = [
    NodePath.join(plan.homeDir, ".local", "share", "mise", "shims"),
    NodePath.join(plan.homeDir, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const descriptor = plan.runtime.descriptor;
  const programArguments = packagedServerProgramArguments(plan);
  const values = {
    homeDir: escapePlistText(plan.homeDir),
    baseDir: escapePlistText(plan.baseDir),
    runtimeDescriptor: escapePlistText(plan.runtime.descriptorPath),
    logPath: escapePlistText(plan.logPath),
    environmentPath: escapePlistText(environmentPath),
    version: escapePlistText(descriptor.version),
    tag: escapePlistText(descriptor.tag),
    buildTag: escapePlistText(descriptor.buildTag),
    commit: escapePlistText(descriptor.commit),
    descriptorSha256: escapePlistText(plan.runtime.descriptorSha256),
  };
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${LASTCODE_PACKAGED_SERVER_SERVICE_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...programArguments.map((argument) => `    <string>${escapePlistText(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>HOME</key>`,
    `    <string>${values.homeDir}</string>`,
    `    <key>PATH</key>`,
    `    <string>${values.environmentPath}</string>`,
    `    <key>ELECTRON_RUN_AS_NODE</key>`,
    `    <string>1</string>`,
    `    <key>NODE_OPTIONS</key>`,
    `    <string></string>`,
    `    <key>NODE_PATH</key>`,
    `    <string></string>`,
    `    <key>T3CODE_HOME</key>`,
    `    <string>${values.baseDir}</string>`,
    `    <key>T3CODE_HOST</key>`,
    `    <string>127.0.0.1</string>`,
    `    <key>LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR</key>`,
    `    <string>${values.runtimeDescriptor}</string>`,
    `    <key>LASTCODE_PACKAGED_RUNTIME_VERSION</key>`,
    `    <string>${values.version}</string>`,
    `    <key>LASTCODE_PACKAGED_RUNTIME_TAG</key>`,
    `    <string>${values.tag}</string>`,
    `    <key>LASTCODE_PACKAGED_RUNTIME_BUILD_TAG</key>`,
    `    <string>${values.buildTag}</string>`,
    `    <key>LASTCODE_PACKAGED_RUNTIME_COMMIT</key>`,
    `    <string>${values.commit}</string>`,
    `    <key>LASTCODE_PACKAGED_RUNTIME_DESCRIPTOR_SHA256</key>`,
    `    <string>${values.descriptorSha256}</string>`,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${values.homeDir}</string>`,
    `  <key>LimitLoadToSessionType</key>`,
    `  <string>Aqua</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${values.logPath}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${values.logPath}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}
