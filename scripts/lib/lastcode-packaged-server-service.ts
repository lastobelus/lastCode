// @effect-diagnostics nodeBuiltinImport:off
// LastCode managed module: packaged server service

import * as NodePath from "node:path";

import type { ValidatedPackagedServerRuntime } from "./lastcode-packaged-server-runtime.ts";
import type { ValidatedPackagedServerSupervisor } from "./lastcode-packaged-server-supervisor.ts";

export const LASTCODE_PACKAGED_SERVER_SERVICE_LABEL = "codes.lastobelus.lastcode.server" as const;
export const LASTCODE_PACKAGED_SERVER_SERVICE_PLIST =
  `${LASTCODE_PACKAGED_SERVER_SERVICE_LABEL}.plist` as const;

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
  const candidateDir = NodePath.resolve(input.runtime.versionDir);
  const isInsideCandidate = (path: string) => {
    const relative = NodePath.relative(candidateDir, NodePath.resolve(path));
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  };
  if (!NodePath.isAbsolute(input.nodePath) || isInsideCandidate(input.nodePath)) {
    throw new Error("The managed Node executable must be an absolute path outside the candidate.");
  }
  if (!NodePath.isAbsolute(input.supervisor.path) || isInsideCandidate(input.supervisor.path)) {
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
    nodePath: input.nodePath,
    supervisor: input.supervisor,
    runtime: input.runtime,
  };
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
  const values = {
    node: escapePlistText(plan.nodePath),
    supervisor: escapePlistText(plan.supervisor.path),
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
    `    <string>${values.node}</string>`,
    `    <string>${values.supervisor}</string>`,
    `    <string>${values.runtimeDescriptor}</string>`,
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
