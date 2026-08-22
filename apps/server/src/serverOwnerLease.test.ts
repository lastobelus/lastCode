// @effect-diagnostics nodeBuiltinImport:off -- Exercises Darwin's kernel-owned local lock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";
import { makeServerLayer } from "./server.ts";
import {
  acquireServerOwnerLease,
  getServerOwnerLeaseLockPath,
  ServerOwnerLeaseHeldError,
  ServerOwnerLeaseUnavailableError,
} from "./serverOwnerLease.ts";

const temporaryDirectories: Array<string> = [];

const makeTemporaryDirectory = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-owner-lease-"));
  temporaryDirectories.push(directory);
  return directory;
};

const makeServerConfig = (baseDir: string): ServerConfig.ServerConfig["Service"] => {
  const stateDir = NodePath.join(baseDir, "userdata");
  const logsDir = NodePath.join(stateDir, "logs");
  const providerLogsDir = NodePath.join(logsDir, "provider");
  return {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: process.cwd(),
    baseDir,
    stateDir,
    dbPath: NodePath.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: NodePath.join(stateDir, "keybindings.json"),
    settingsPath: NodePath.join(stateDir, "settings.json"),
    providerStatusCacheDir: NodePath.join(baseDir, "caches"),
    worktreesDir: NodePath.join(baseDir, "worktrees"),
    attachmentsDir: NodePath.join(stateDir, "attachments"),
    logsDir,
    serverLogPath: NodePath.join(logsDir, "server.log"),
    serverTracePath: NodePath.join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: NodePath.join(providerLogsDir, "events.log"),
    terminalLogsDir: NodePath.join(logsDir, "terminals"),
    anonymousIdPath: NodePath.join(stateDir, "anonymous-id"),
    environmentIdPath: NodePath.join(stateDir, "environment-id"),
    serverRuntimeStatePath: NodePath.join(stateDir, "server-runtime.json"),
    secretsDir: NodePath.join(stateDir, "secrets"),
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  };
};

const spawnLeaseOwner = (source: string, argument: string) =>
  Effect.promise(
    () =>
      new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, ["-e", source, argument], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        child.stdout.once("data", () => resolve(child));
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Lease holder exited before listening.")));
      }),
  );

const spawnDarwinLockOwner = (lockPath: string) =>
  spawnLeaseOwner(
    [
      'const fs = require("node:fs");',
      "fs.openSync(process.argv[1], fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NONBLOCK | 0x20 | 0x100, 0o600);",
      'process.stdout.write("owned\\n");',
      "setInterval(() => {}, 1_000);",
    ].join("\n"),
    lockPath,
  );

const terminateChild = (child: NodeChildProcess.ChildProcess) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  );

const waitForChildExit = (child: NodeChildProcess.ChildProcess) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
      }),
  );

const acquireScopedLease = (baseDir: string) =>
  Effect.acquireRelease(acquireServerOwnerLease(baseDir), (lease) => lease.release);

const acquireScopedChild = (effect: Effect.Effect<NodeChildProcess.ChildProcess>) =>
  Effect.acquireRelease(effect, terminateChild);

const cleanup = Effect.sync(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

it.effect("rejects a second owner with an actionable per-home diagnostic", () => {
  const home = makeTemporaryDirectory();
  return Effect.scoped(
    Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- The lease is intentionally Darwin-only.
      if (process.platform !== "darwin") return;
      yield* acquireScopedLease(home);
      const error = yield* acquireServerOwnerLease(home).pipe(Effect.flip);

      assert.instanceOf(error, ServerOwnerLeaseHeldError);
      assert.include(error.message, home);
      assert.include(error.message, "--base-dir");
    }),
  ).pipe(Effect.ensuring(cleanup));
});

it.effect("allows independent T3 homes to have separate owners", () => {
  const firstHome = makeTemporaryDirectory();
  const secondHome = makeTemporaryDirectory();
  return Effect.scoped(
    Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- The lease is intentionally Darwin-only.
      if (process.platform !== "darwin") return;
      const first = yield* acquireScopedLease(firstHome);
      const second = yield* acquireScopedLease(secondHome);

      assert.notEqual(first.endpoint, second.endpoint);
    }),
  ).pipe(Effect.ensuring(cleanup));
});

it.effect("allows dev and production state in one T3 home to have separate owners", () => {
  const home = makeTemporaryDirectory();
  return Effect.scoped(
    Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- The lease is intentionally Darwin-only.
      if (process.platform !== "darwin") return;
      const production = yield* acquireScopedLease(NodePath.join(home, "userdata"));
      const development = yield* acquireScopedLease(NodePath.join(home, "dev"));

      assert.notEqual(production.endpoint, development.endpoint);
    }),
  ).pipe(Effect.ensuring(cleanup));
});

it.effect("fails before the server can construct persistence or listen", () => {
  const home = makeTemporaryDirectory();
  return Effect.scoped(
    Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- The lease is intentionally Darwin-only.
      if (process.platform !== "darwin") return;
      const config = makeServerConfig(home);
      yield* acquireScopedLease(config.stateDir);
      const error = yield* Layer.build(makeServerLayer).pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layer(config), NodeServices.layer)),
        Effect.flip,
      );

      assert.instanceOf(error, ServerOwnerLeaseHeldError);
      assert.isFalse(NodeFS.existsSync(config.dbPath));
    }),
  ).pipe(Effect.ensuring(cleanup));
});

it.effect("fails closed instead of following a Darwin lock-path symlink", () => {
  const home = makeTemporaryDirectory();
  return Effect.gen(function* () {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- O_NOFOLLOW is Darwin-specific.
    if (process.platform !== "darwin") return;
    const target = NodePath.join(home, "must-not-change");
    NodeFS.writeFileSync(target, "safe");
    NodeFS.symlinkSync(target, getServerOwnerLeaseLockPath(home));

    const error = yield* acquireServerOwnerLease(home).pipe(Effect.flip);

    assert.instanceOf(error, ServerOwnerLeaseUnavailableError);
    assert.equal(NodeFS.readFileSync(target, "utf8"), "safe");
  }).pipe(Effect.ensuring(cleanup));
});

it.effect("fails closed when the Darwin lock path is not a regular file", () => {
  const home = makeTemporaryDirectory();
  return Effect.gen(function* () {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- O_EXLOCK is Darwin-specific.
    if (process.platform !== "darwin") return;
    NodeFS.mkdirSync(getServerOwnerLeaseLockPath(home));

    const error = yield* acquireServerOwnerLease(home).pipe(Effect.flip);

    assert.instanceOf(error, ServerOwnerLeaseUnavailableError);
  }).pipe(Effect.ensuring(cleanup));
});

it.effect("reclaims the lease after its owner crashes", () => {
  const home = makeTemporaryDirectory();
  return Effect.scoped(
    Effect.gen(function* () {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- O_EXLOCK is Darwin-specific.
      if (process.platform !== "darwin") return;
      const holder = yield* acquireScopedChild(
        spawnDarwinLockOwner(getServerOwnerLeaseLockPath(home)),
      );

      // This is the exact child spawned above, not a process located by pattern.
      holder.kill("SIGKILL");
      yield* waitForChildExit(holder);

      yield* acquireScopedLease(home);
    }),
  ).pipe(Effect.ensuring(cleanup));
});
