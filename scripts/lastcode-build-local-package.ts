#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Host-side local packaging.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { acquirePortableLock } from "./lastcode-lock.mjs";

import { lastCodeAction } from "./lib/lastcode-action-kit.ts";
import { resolveExistingBuild } from "./lastcode-local-update.mjs";

const TAG = /^lastcode\/(?:checkpoint|revision)\/v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+(?:\.\d+)?$/u;
const TOKEN = /^local-[0-9a-f-]{36}$/u;
const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";

export type LocalBuildRequest = {
  readonly schemaVersion: 1;
  readonly tag: string;
  readonly commit: string;
  readonly requestToken: string;
};
export type LocalBuildResult = {
  readonly schemaVersion: 1;
  readonly status: "built";
  readonly checkpointTag: string;
  readonly outputDir: string;
  readonly manifestPath: string;
  readonly dmgPath: string;
  readonly dmgSha256: string;
};
export type LocalBuildDeps = {
  readonly git: (root: string, args: ReadonlyArray<string>) => string;
  readonly writeRequest: (request: LocalBuildRequest) => void;
  readonly readRequest: () => LocalBuildRequest;
  readonly execute: (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) =>
    | { readonly code: number; readonly stdout: string; readonly stderr: string }
    | Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  readonly verifyResult?: (
    result: LocalBuildResult,
    request: LocalBuildRequest,
    root: string,
  ) => void;
  readonly progress?: (input: {
    readonly state: "working" | "waiting";
    readonly phase: string;
    readonly summary: string;
  }) => void;
};

export function requestPath(repoRoot: string, git: LocalBuildDeps["git"] = defaultGit): string {
  return NodePath.resolve(
    repoRoot,
    git(repoRoot, ["rev-parse", "--git-path", "lastcode-actions/build-local-package.json"]),
  );
}
function defaultGit(root: string, args: ReadonlyArray<string>): string {
  const r = NodeChildProcess.spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  if (r.status !== 0) throw new Error(r.error?.message || r.stderr?.trim() || "git failed");
  return r.stdout.trim();
}
function exactTag(tag: string): string {
  if (!TAG.test(tag))
    throw new Error(
      "Expected an exact lastcode/checkpoint/... or lastcode/revision/... nightly tag.",
    );
  return tag;
}
export function selectLocalBuild(
  repoRoot: string,
  tag: string,
  deps: Pick<LocalBuildDeps, "git" | "writeRequest">,
  token = `local-${NodeCrypto.randomUUID()}`,
): LocalBuildRequest {
  const selected = exactTag(tag);
  const commit = deps.git(repoRoot, ["rev-parse", `${selected}^{commit}`]);
  if (!/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("Selected build returned an invalid commit.");
  if (!TOKEN.test(token)) throw new Error("Invalid local build request token.");
  const request = { schemaVersion: 1 as const, tag: selected, commit, requestToken: token };
  deps.writeRequest(request);
  return request;
}
function validateRequest(value: unknown): LocalBuildRequest {
  if (value === null || typeof value !== "object")
    throw new Error("Local build selection is invalid.");
  const request = value as Partial<LocalBuildRequest>;
  if (
    request.schemaVersion !== 1 ||
    typeof request.tag !== "string" ||
    !TAG.test(request.tag) ||
    typeof request.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(request.commit) ||
    typeof request.requestToken !== "string" ||
    !TOKEN.test(request.requestToken)
  )
    throw new Error("Local build selection is invalid.");
  return request as LocalBuildRequest;
}
export function parseBuildResult(stdout: string): LocalBuildResult {
  const lines = stdout.split(/\r?\n/u).filter((value) => value.startsWith(RESULT_PREFIX));
  const line = lines[0];
  if (!line || lines.length !== 1)
    throw new Error("The local build helper did not return exactly one build result.");
  const result: unknown = JSON.parse(line.slice(RESULT_PREFIX.length));
  if (
    result === null ||
    typeof result !== "object" ||
    (result as Record<string, unknown>).schemaVersion !== 1 ||
    (result as Record<string, unknown>).status !== "built" ||
    typeof (result as Record<string, unknown>).checkpointTag !== "string" ||
    typeof (result as Record<string, unknown>).outputDir !== "string" ||
    typeof (result as Record<string, unknown>).manifestPath !== "string" ||
    typeof (result as Record<string, unknown>).dmgPath !== "string" ||
    typeof (result as Record<string, unknown>).dmgSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test((result as Record<string, string>).dmgSha256!)
  )
    throw new Error("The local build helper returned an invalid build result.");
  return result as LocalBuildResult;
}
export async function runLocalBuild(
  repoRoot: string,
  deps: LocalBuildDeps,
): Promise<LocalBuildResult> {
  const request = validateRequest(deps.readRequest());
  exactTag(request.tag);
  const before = deps.git(repoRoot, ["rev-parse", `${request.tag}^{commit}`]);
  if (before !== request.commit)
    throw new Error(`Selected tag ${request.tag} moved or no longer points to ${request.commit}.`);
  deps.progress?.({ state: "working", phase: "build", summary: `Building ${request.tag}` });
  const result = await deps.execute(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "lastcode-local-update.mjs"),
      "build",
      "--repo",
      repoRoot,
      "--home",
      NodeOS.homedir(),
      "--checkpoint",
      request.tag,
    ],
    repoRoot,
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `Local build failed with exit code ${result.code}.`);
  const built = parseBuildResult(result.stdout);
  if (built.checkpointTag !== request.tag)
    throw new Error(`Build result targeted ${built.checkpointTag}, expected ${request.tag}.`);
  (deps.verifyResult ?? verifyLocalBuild)(built, request, repoRoot);
  const after = deps.git(repoRoot, ["rev-parse", `${request.tag}^{commit}`]);
  if (after !== request.commit)
    throw new Error(`Selected tag ${request.tag} changed during the build.`);
  return built;
}

export function verifyLocalBuild(
  built: LocalBuildResult,
  request: LocalBuildRequest,
  repoRoot: string,
  home = NodeOS.homedir(),
): void {
  const verified = resolveExistingBuild({
    repoRoot,
    outputRoot: NodePath.join(home, ".lastcode", "local-updates", "artifacts"),
    checkpointTag: request.tag,
    checkpointCommit: request.commit,
  });
  if (
    !verified ||
    verified.outputDir !== built.outputDir ||
    built.manifestPath !== verified.manifestPath ||
    built.dmgPath !== verified.dmgPath ||
    built.dmgSha256 !== verified.dmgSha256
  )
    throw new Error("Build result does not describe a complete verified artifact.");
}

/** Serialize selection and consumption so concurrent launches cannot reuse a request. */
export function withRequestLock<T>(path: string, operation: () => T): T {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const release = acquirePortableLock(
    NodePath.dirname(path),
    "build-local-package.lock",
    "local build selection",
  );
  try {
    return operation();
  } finally {
    release();
  }
}
export function writeSelection(path: string, request: LocalBuildRequest): void {
  withRequestLock(path, () => {
    const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      NodeFS.writeFileSync(temporary, `${JSON.stringify(validateRequest(request), null, 2)}\n`, {
        mode: 0o600,
      });
      NodeFS.renameSync(temporary, path);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  });
}
export function consumeSelection(path: string): LocalBuildRequest {
  return withRequestLock(path, () => {
    if (!NodeFS.existsSync(path))
      throw new Error(
        "Select an exact tag before running Build Local Package; each selection permits one attempt.",
      );
    const request = validateRequest(JSON.parse(NodeFS.readFileSync(path, "utf8")));
    NodeFS.rmSync(path);
    return request;
  });
}

/** Own a child process group; cancellation only signals processes spawned for this build. */
export async function executeBuild(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = NodeChildProcess.spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-64 * 1024);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-64 * 1024);
  });
  const cancel = () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? 1));
    });
    signal?.throwIfAborted();
    return { code, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
async function main(argv: ReadonlyArray<string>): Promise<void> {
  const command = argv[0];
  const repoRoot = process.cwd();
  if (command === "select" && argv.length === 3 && argv[1] === "--tag") {
    selectLocalBuild(repoRoot, argv[2]!, {
      git: defaultGit,
      writeRequest: (request) => writeSelection(requestPath(repoRoot), request),
    });
    return;
  }
  if (command !== "run" || argv.length !== 1)
    throw new Error(
      "Usage: lastcode-build-local-package.ts select --tag <exact-tag> | lastcode-build-local-package.ts run",
    );
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build Action has no Effect runtime.
  if (NodeOS.platform() !== "darwin" || NodeOS.arch() !== "arm64")
    throw new Error("Build Local Package requires an Apple Silicon macOS host.");
  const request = consumeSelection(requestPath(repoRoot));
  const canonicalRoot = NodePath.resolve(import.meta.dirname, "..");
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort(new Error("Local build cancelled."));
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort(new Error("Local build cancelled."));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const built = await runLocalBuild(canonicalRoot, {
      git: defaultGit,
      readRequest: () => request,
      writeRequest: () => {},
      execute: (cmd, args, cwd) => executeBuild(cmd, args, cwd, controller.signal),
      progress: (value) => lastCodeAction.progress(value),
    });
    lastCodeAction.result({
      outcome: "success",
      reason: "built",
      summary: `Local package ${built.checkpointTag} is ready`,
      subject: { type: "local-build", id: built.checkpointTag, revision: request.commit },
      facts: {
        outputDir: built.outputDir,
        dmgPath: built.dmgPath,
        manifestPath: built.manifestPath,
        dmgSha256: built.dmgSha256,
      },
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[build-local] ${message}`);
    if (process.argv[2] !== "run") process.exitCode = 1;
    lastCodeAction.result({
      outcome: "attention",
      reason: process.exitCode === 130 || process.exitCode === 143 ? "cancelled" : "build-failed",
      summary: message.slice(0, 280),
      facts: {
        status: process.exitCode === 130 || process.exitCode === 143 ? "cancelled" : "failed",
      },
    });
  }
}
