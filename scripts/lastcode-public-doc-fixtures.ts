#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side capture fixture runner with owned child-process readiness polling.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import {
  PUBLIC_DOCS_PROJECT_ID,
  PUBLIC_DOCS_THREAD_ID,
  PUBLIC_DOCS_THREADS,
  seedShowcaseEnvironment,
} from "./mobile-showcase-environment.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const RuntimeProcess = (NodeProcess as typeof NodeProcess & { readonly default: NodeJS.Process })
  .default;
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const READY_PREFIX = "LASTCODE_DOCS_FIXTURE_READY=";
const FIXTURE_SCHEMA_VERSION = 1;
const STARTUP_TIMEOUT_MS = 60_000;

export interface PublicDocsFixtureCliOptions {
  readonly commit: string;
  readonly outputDirectory: string;
}

export interface PublicDocsFixtureMetadata {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly profile: "public-docs";
  readonly serverOrigin: string;
  readonly projectId: string;
  readonly threadIds: ReadonlyArray<string>;
  readonly paths: {
    readonly outputDirectory: string;
    readonly baseDir: string;
    readonly homeDirectory: string;
    readonly workspaceRoot: string;
    readonly electronUserDataDirectory: string;
  };
}

interface DevRunnerState {
  serverPort?: number;
  webPort?: number;
  pairingUrl?: string;
  outputTail: string;
}

interface OwnedDevRunner {
  readonly child: NodeChildProcess.ChildProcess;
  readonly state: DevRunnerState;
}

interface PublicDocsFixtureRuntime {
  readonly resolveSourceCommit: (requestedCommit: string) => Promise<string>;
  readonly waitForShutdown: (child: NodeChildProcess.ChildProcess) => Promise<void>;
  readonly writeReady: (ready: Record<string, unknown>) => void;
}

export function parsePublicDocsFixtureCliArgs(
  argv: ReadonlyArray<string>,
): PublicDocsFixtureCliOptions {
  let commit: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? "argument"}.`);
    if (flag === "--commit") commit = value;
    else if (flag === "--output") outputDirectory = value;
    else throw new Error(`Unknown argument '${flag}'.`);
  }
  if (!commit?.trim()) throw new Error("Missing --commit.");
  if (!outputDirectory?.trim()) throw new Error("Missing --output.");
  return { commit: commit.trim(), outputDirectory: NodePath.resolve(outputDirectory) };
}

export function redactFixtureCredentials(value: string): string {
  return value
    .replace(/([#&?]token=)[^\s&"'}]+/giu, "$1[redacted]")
    .replace(/("credential"\s*:\s*")[^"]+/giu, "$1[redacted]");
}

function safeHostEnvironment(homeDirectory: string, baseDir: string): NodeJS.ProcessEnv {
  const inheritedKeys = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "ComSpec",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
  ] as const;
  const environment = Object.fromEntries(
    inheritedKeys.flatMap((key) =>
      NodeProcess.env[key] === undefined ? [] : [[key, NodeProcess.env[key]]],
    ),
  );
  return {
    ...environment,
    PATH: `${NodePath.join(REPO_ROOT, "node_modules", ".bin")}${NodePath.delimiter}${environment.PATH ?? ""}`,
    HOME: homeDirectory,
    USER: "lastcode-docs",
    LOGNAME: "lastcode-docs",
    T3CODE_HOME: baseDir,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
}

export async function resolveSourceCommit(
  requestedCommit: string,
  repoRoot = REPO_ROOT,
): Promise<string> {
  const [{ stdout: requested }, { stdout: head }, { stdout: status }] = await Promise.all([
    execFile("git", ["rev-parse", "--verify", `${requestedCommit}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
    execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }),
    execFile("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  ]);
  const sourceCommit = requested.trim();
  if (sourceCommit !== head.trim()) {
    throw new Error(
      `The requested LastCode commit ${sourceCommit} is not this checkout's HEAD ${head.trim()}.`,
    );
  }
  if (status.trim()) {
    throw new Error("The LastCode checkout must be clean before creating public captures.");
  }
  return sourceCommit;
}

async function ensureDisposableOutputDirectory(outputDirectory: string): Promise<void> {
  const root = NodePath.parse(outputDirectory).root;
  const protectedPaths = new Set([root, NodePath.resolve(NodeOS.homedir()), REPO_ROOT]);
  if (protectedPaths.has(outputDirectory)) {
    throw new Error(`Refusing to use protected output directory '${outputDirectory}'.`);
  }
  await NodeFSP.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const entries = await NodeFSP.readdir(outputDirectory);
  if (entries.length > 0) {
    throw new Error(`The disposable output directory must be empty: '${outputDirectory}'.`);
  }
}

export function resolvePackagedUserDataDirectory(
  homeDirectory: string,
  platform: NodeJS.Platform = NodeProcess.platform,
): string {
  if (platform === "darwin") {
    return NodePath.join(homeDirectory, "Library", "Application Support", "lastcode");
  }
  if (platform === "win32") {
    return NodePath.join(homeDirectory, "AppData", "Roaming", "lastcode");
  }
  return NodePath.join(homeDirectory, ".config", "lastcode");
}

export async function preparePublicDocsDesktopFixture(input: {
  readonly outputDirectory: string;
  readonly baseDir: string;
  readonly homeDirectory: string;
}): Promise<{ readonly electronUserDataDirectory: string }> {
  const fakeRepository = NodePath.join(input.outputDirectory, "fake-update-repository");
  const scriptsDirectory = NodePath.join(fakeRepository, "scripts");
  const dashboardDirectory = NodePath.join(input.homeDirectory, ".lastcode");
  const stateDirectory = NodePath.join(input.baseDir, "userdata");
  const electronUserDataDirectory = resolvePackagedUserDataDirectory(input.homeDirectory);
  await Promise.all([
    NodeFSP.mkdir(scriptsDirectory, { recursive: true, mode: 0o700 }),
    NodeFSP.mkdir(dashboardDirectory, { recursive: true, mode: 0o700 }),
    NodeFSP.mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
    NodeFSP.mkdir(electronUserDataDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const helperPath = NodePath.join(scriptsDirectory, "lastcode-local-update.mjs");
  const installerPath = NodePath.join(scriptsDirectory, "lastcode-install.mjs");
  await Promise.all([
    NodeFSP.copyFile(
      NodePath.join(REPO_ROOT, "scripts", "fixtures", "lastcode-docs-local-update.mjs"),
      helperPath,
    ),
    NodeFSP.copyFile(
      NodePath.join(REPO_ROOT, "scripts", "fixtures", "lastcode-docs-install.mjs"),
      installerPath,
    ),
    NodeFSP.writeFile(
      NodePath.join(dashboardDirectory, "dashboard.json"),
      `${JSON.stringify({ repoRoot: fakeRepository }, null, 2)}\n`,
      { mode: 0o600 },
    ),
    NodeFSP.writeFile(
      NodePath.join(stateDirectory, "desktop-settings.json"),
      `${JSON.stringify(
        {
          mainWindowBounds: { x: 80, y: 60, width: 1280, height: 820 },
          showAndInstallLocalNightlies: true,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    ),
  ]);
  await Promise.all([NodeFSP.chmod(helperPath, 0o700), NodeFSP.chmod(installerPath, 0o700)]);
  return { electronUserDataDirectory };
}

function parsePairingUrl(output: string): string | undefined {
  for (const line of NodeUtil.stripVTControlCharacters(output).split(/\r?\n/u).toReversed()) {
    if (!line.includes("pairingUrl")) continue;
    const candidate = /https?:\/\/[^\s"']+/u.exec(line)?.[0]?.replace(/[},]+$/u, "");
    if (candidate === undefined) continue;
    try {
      const url = new URL(candidate);
      if (url.hash.includes("token=")) return url.toString();
    } catch {
      // Keep looking for a complete pairing URL in a later chunk.
    }
  }
  return undefined;
}

function observeDevRunnerOutput(state: DevRunnerState, chunk: string): void {
  state.outputTail = `${state.outputTail}${chunk}`.slice(-32_000);
  const plain = NodeUtil.stripVTControlCharacters(state.outputTail);
  const ports = /serverPort=(\d+) webPort=(\d+) baseDir=/u.exec(plain);
  if (ports) {
    state.serverPort = Number(ports[1]);
    state.webPort = Number(ports[2]);
  }
  const pairingUrl = parsePairingUrl(plain);
  if (pairingUrl !== undefined) state.pairingUrl = pairingUrl;
}

function startDevRunner(
  mode: "dev" | "dev:server",
  baseDir: string,
  environment: NodeJS.ProcessEnv,
): OwnedDevRunner {
  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    ["scripts/dev-runner.ts", mode, "--home-dir", baseDir],
    {
      cwd: REPO_ROOT,
      detached: NodeProcess.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const state: DevRunnerState = { outputTail: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => observeDevRunnerOutput(state, chunk));
  child.stderr?.on("data", (chunk: string) => observeDevRunnerOutput(state, chunk));
  return { child, state };
}

async function waitForReadiness(
  runner: OwnedDevRunner,
  ready: (state: DevRunnerState) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ready(runner.state)) return;
    if (runner.child.exitCode !== null) {
      throw new Error(
        `${label} exited with ${runner.child.exitCode}. ${redactFixtureCredentials(runner.state.outputTail)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${label} did not become ready. ${redactFixtureCredentials(runner.state.outputTail)}`,
  );
}

function signalOwnedProcess(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (NodeProcess.platform === "win32") child.kill(signal);
  else NodeProcess.kill(-child.pid, signal);
}

async function stopOwnedProcess(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalOwnedProcess(child, "SIGTERM");
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => signalOwnedProcess(child, "SIGKILL"), 10_000);
    child.once("close", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

async function waitForShutdown(child: NodeChildProcess.ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSignal = () => {
      cleanup();
      resolve();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Fixture dev server exited unexpectedly (${code ?? signal ?? "unknown"}).`));
    };
    const cleanup = () => {
      RuntimeProcess.off("SIGINT", onSignal);
      RuntimeProcess.off("SIGTERM", onSignal);
      child.off("close", onClose);
    };
    RuntimeProcess.once("SIGINT", onSignal);
    RuntimeProcess.once("SIGTERM", onSignal);
    child.once("close", onClose);
  });
}

export async function runPublicDocsFixture(
  options: PublicDocsFixtureCliOptions,
  runtime: Partial<PublicDocsFixtureRuntime> = {},
): Promise<void> {
  const sourceCommit = await (runtime.resolveSourceCommit ?? resolveSourceCommit)(options.commit);
  await ensureDisposableOutputDirectory(options.outputDirectory);
  const baseDir = NodePath.join(options.outputDirectory, "environment");
  const homeDirectory = NodePath.join(options.outputDirectory, "home");
  await Promise.all([
    NodeFSP.mkdir(baseDir, { recursive: true, mode: 0o700 }),
    NodeFSP.mkdir(homeDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const environment = safeHostEnvironment(homeDirectory, baseDir);
  const desktop = await preparePublicDocsDesktopFixture({
    outputDirectory: options.outputDirectory,
    baseDir,
    homeDirectory,
  });

  const bootstrap = startDevRunner("dev:server", baseDir, environment);
  let workspaceRoot: string;
  try {
    await waitForReadiness(
      bootstrap,
      ({ serverPort, pairingUrl }) => serverPort !== undefined && pairingUrl !== undefined,
      "Fixture migration server",
    );
    ({ workspaceRoot } = await seedShowcaseEnvironment({
      baseDir,
      profile: "public-docs",
    }));
  } finally {
    await stopOwnedProcess(bootstrap.child);
  }

  const server = startDevRunner("dev", baseDir, environment);
  try {
    await waitForReadiness(
      server,
      ({ webPort, pairingUrl }) => webPort !== undefined && pairingUrl !== undefined,
      "Public documentation dev server",
    );
    const pairingUrl = server.state.pairingUrl as string;
    const serverOrigin = `http://localhost:${server.state.webPort as number}/`;
    const metadata: PublicDocsFixtureMetadata = {
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      sourceCommit,
      profile: "public-docs",
      serverOrigin,
      projectId: PUBLIC_DOCS_PROJECT_ID,
      threadIds: PUBLIC_DOCS_THREADS.map(({ id }) => id),
      paths: {
        outputDirectory: options.outputDirectory,
        baseDir,
        homeDirectory,
        workspaceRoot,
        electronUserDataDirectory: desktop.electronUserDataDirectory,
      },
    };
    await NodeFSP.writeFile(
      NodePath.join(options.outputDirectory, "fixture.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600 },
    );
    const ready = { ...metadata, pairingUrl, primaryThreadId: PUBLIC_DOCS_THREAD_ID };
    if (runtime.writeReady) runtime.writeReady(ready);
    else NodeProcess.stdout.write(`${READY_PREFIX}${JSON.stringify(ready)}\n`);
    await (runtime.waitForShutdown ?? waitForShutdown)(server.child);
  } finally {
    await stopOwnedProcess(server.child);
  }
}

if (import.meta.main) {
  runPublicDocsFixture(parsePublicDocsFixtureCliArgs(NodeProcess.argv.slice(2))).catch((error) => {
    NodeProcess.stderr.write(
      `${redactFixtureCredentials(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
}
