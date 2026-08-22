// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This desktop-only service launches helpers and owns a Node pipe timeout inside a Promise callback.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeUtil from "node:util";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  BUILD_PHASES,
  estimateBuildProgress,
  resolveBuildPhaseIndex,
} from "../../../../scripts/lib/lastcode-build-progress.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";
const INSTALL_READY_PREFIX = "LASTCODE_INSTALL_READY=";
const BUILD_PROGRESS_POLL_INTERVAL = Duration.millis(400);
const BUILD_PROGRESS_EMIT_INTERVAL_MS = 1_000;
const MAX_BUILD_LOG_BYTES_PER_POLL = 512_000;
const BUILD_LOG_MARKER_CARRY_LENGTH = 512;
const PACKAGING_PHASE_INDEX = BUILD_PHASES.findIndex(
  ({ marker }) => marker === "[desktop-artifact] Building desktop/server/web artifacts",
);

export interface LastCodeLocalBuildProgress {
  readonly phase: string;
  readonly percent: number;
  readonly errorKind: "build" | "packaging";
}

interface BuildLogIdentity {
  readonly device: number;
  readonly inode: number;
}

function readBuildLogIdentity(stat: NodeFS.Stats): BuildLogIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameBuildLogIdentity(
  left: BuildLogIdentity | undefined,
  right: BuildLogIdentity,
): boolean {
  return left?.device === right.device && left.inode === right.inode;
}

export function resolveLocalBuildErrorKind(phaseIndex: number): "build" | "packaging" {
  return phaseIndex >= PACKAGING_PHASE_INDEX ? "packaging" : "build";
}

export function initialLocalBuildProgress(): LastCodeLocalBuildProgress {
  return {
    phase: BUILD_PHASES[0].label,
    percent: 0,
    errorKind: "build",
  };
}

export class LocalBuildProgressTracker {
  readonly #logPath: string;
  #offset = 0;
  #identity: BuildLogIdentity | undefined;
  #decoder = new NodeStringDecoder.StringDecoder("utf8");
  #markerCarry = "";
  #phaseIndex = 0;
  #phaseStartedAt: number;
  #lastEmittedAt: number;
  #lastEmittedPercent = 0;

  constructor(logPath: string, startedAt: number) {
    this.#logPath = logPath;
    this.#phaseStartedAt = startedAt;
    this.#lastEmittedAt = startedAt;
    try {
      const stat = NodeFS.statSync(logPath);
      this.#offset = stat.size;
      this.#identity = readBuildLogIdentity(stat);
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
    }
  }

  poll(now: number): LastCodeLocalBuildProgress | null {
    const previousPhaseIndex = this.#phaseIndex;
    for (const appended of this.#readAppendedLog()) {
      const plainAppended = NodeUtil.stripVTControlCharacters(appended);
      this.#phaseIndex = resolveBuildPhaseIndex(
        `${this.#markerCarry}${plainAppended}`,
        this.#phaseIndex,
      );
      this.#markerCarry = `${this.#markerCarry}${plainAppended}`.slice(
        -BUILD_LOG_MARKER_CARRY_LENGTH,
      );
      if (this.#phaseIndex !== previousPhaseIndex) this.#phaseStartedAt = now;
    }

    const percent = Math.min(
      99,
      Math.max(
        this.#lastEmittedPercent,
        Math.floor(estimateBuildProgress(this.#phaseIndex, now - this.#phaseStartedAt) * 100),
      ),
    );
    const phaseChanged = this.#phaseIndex !== previousPhaseIndex;
    const interpolationDue =
      percent > this.#lastEmittedPercent &&
      now - this.#lastEmittedAt >= BUILD_PROGRESS_EMIT_INTERVAL_MS;
    if (!phaseChanged && !interpolationDue) return null;

    this.#lastEmittedAt = now;
    this.#lastEmittedPercent = percent;
    return {
      phase: BUILD_PHASES[this.#phaseIndex]?.label ?? BUILD_PHASES[0].label,
      percent,
      errorKind: resolveLocalBuildErrorKind(this.#phaseIndex),
    };
  }

  hasPendingLogBytes(): boolean {
    try {
      const stat = NodeFS.statSync(this.#logPath);
      return (
        !sameBuildLogIdentity(this.#identity, readBuildLogIdentity(stat)) ||
        stat.size !== this.#offset
      );
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
      throw cause;
    }
  }

  *#readAppendedLog(): Generator<string> {
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(this.#logPath);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
      throw cause;
    }

    const identity = readBuildLogIdentity(stat);
    if (!sameBuildLogIdentity(this.#identity, identity) || stat.size < this.#offset) {
      this.#offset = 0;
      this.#identity = identity;
      this.#decoder = new NodeStringDecoder.StringDecoder("utf8");
      this.#markerCarry = "";
    }
    if (stat.size <= this.#offset) return;

    const fd = NodeFS.openSync(this.#logPath, "r");
    try {
      const length = Math.min(MAX_BUILD_LOG_BYTES_PER_POLL, stat.size - this.#offset);
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = NodeFS.readSync(fd, buffer, 0, length, this.#offset);
      if (bytesRead === 0) return;
      this.#offset += bytesRead;
      yield this.#decoder.write(buffer.subarray(0, bytesRead));
    } finally {
      NodeFS.closeSync(fd);
    }
  }
}

export function monitorLocalBuildProgress<A, E, R>(
  logPath: string,
  helperEffect: Effect.Effect<A, E, R>,
  onProgress: (progress: LastCodeLocalBuildProgress) => Effect.Effect<void>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const tracker = new LocalBuildProgressTracker(logPath, startedAt);
    const pollProgress = Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        const progress = tracker.poll(now);
        return progress ? onProgress(progress) : Effect.void;
      }),
    );
    const monitor = Effect.forever(
      pollProgress.pipe(
        Effect.catchCause(() => Effect.void),
        Effect.andThen(Effect.sleep(BUILD_PROGRESS_POLL_INTERVAL)),
      ),
    );
    const monitorFiber = yield* monitor.pipe(Effect.forkChild({ startImmediately: true }));
    const drainProgress = Effect.gen(function* () {
      while (tracker.hasPendingLogBytes()) {
        yield* pollProgress;
        yield* Effect.yieldNow;
      }
    }).pipe(Effect.catchCause(() => Effect.void));
    return yield* helperEffect.pipe(
      Effect.ensuring(
        drainProgress.pipe(Effect.andThen(Fiber.interrupt(monitorFiber)), Effect.asVoid),
      ),
    );
  });
}

const LastCodeReleaseNotes = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("known"),
    items: Schema.Array(Schema.String),
    omittedItems: Schema.Number,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);

const UpstreamReleaseNotes = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      version: Schema.String,
      isTarget: Schema.Boolean,
      items: Schema.Array(Schema.String),
      omittedItems: Schema.Number,
    }),
  ),
  omittedGroups: Schema.Number,
});

const InspectionResult = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(2),
    status: Schema.Literal("up-to-date"),
    checkpointTag: Schema.String,
    availableVersion: Schema.String,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(2),
    status: Schema.Literal("available"),
    checkpointTag: Schema.String,
    availableVersion: Schema.String,
    releaseNotes: Schema.Struct({
      lastCode: LastCodeReleaseNotes,
      upstream: UpstreamReleaseNotes,
    }),
  }),
]);
export type LastCodeLocalUpdateInspection = typeof InspectionResult.Type;

const BuildResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("built"),
  checkpointTag: Schema.String,
  outputDir: Schema.String,
  manifestPath: Schema.String,
  dmgPath: Schema.String,
  dmgSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type LastCodeLocalUpdateBuild = typeof BuildResult.Type;

const InstallReadyResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  artifactPath: Schema.String,
  version: Schema.String,
});
const decodeInstallReadyResult = Schema.decodeUnknownSync(InstallReadyResult);

const DashboardConfig = Schema.Struct({ repoRoot: Schema.String });
const decodeDashboardConfig = Schema.decodeUnknownSync(Schema.fromJsonString(DashboardConfig));
const decodeInspectionResult = Schema.decodeUnknownSync(InspectionResult);
const decodeBuildResult = Schema.decodeUnknownSync(BuildResult);

export class LastCodeLocalUpdateError extends Schema.TaggedErrorClass<LastCodeLocalUpdateError>()(
  "LastCodeLocalUpdateError",
  {
    operation: Schema.Literals(["configuration", "inspect", "build", "install"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface LastCodeLocalInstallHandoff {
  readonly commit: Effect.Effect<void, LastCodeLocalUpdateError>;
  readonly cancel: Effect.Effect<void>;
}

export class LastCodeLocalUpdates extends Context.Service<
  LastCodeLocalUpdates,
  {
    readonly supported: boolean;
    readonly buildLogPath: string;
    readonly inspect: (
      currentVersion: string,
    ) => Effect.Effect<LastCodeLocalUpdateInspection, LastCodeLocalUpdateError>;
    readonly build: (
      checkpointTag: string,
      onProgress?: (progress: LastCodeLocalBuildProgress) => Effect.Effect<void>,
    ) => Effect.Effect<LastCodeLocalUpdateBuild, LastCodeLocalUpdateError>;
    readonly prepareInstall: (args: {
      readonly dmgPath: string;
      readonly dmgSha256: string;
      readonly expectedVersion: string;
    }) => Effect.Effect<LastCodeLocalInstallHandoff, LastCodeLocalUpdateError>;
  }
>()("@t3tools/desktop/updates/LastCodeLocalUpdates") {}

const isLastCodeLocalUpdateError = Schema.is(LastCodeLocalUpdateError);

export function parseHelperResult(raw: string): unknown {
  const line = raw
    .split(/\r?\n/)
    .toReversed()
    .find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) throw new Error("Local updater helper did not return a result.");
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

export function usesDetachedHelperProcessGroup(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

export function groupedInspectionArgs(currentVersion: string): ReadonlyArray<string> {
  return ["--current-version", currentVersion, "--release-notes-format", "grouped-v1"];
}

export function terminateHelperProcess(
  child: Pick<NodeChildProcess.ChildProcess, "pid" | "kill">,
  platform: NodeJS.Platform,
  killProcess: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
): boolean {
  if (child.pid !== undefined && usesDetachedHelperProcessGroup(platform)) {
    try {
      return killProcess(-child.pid, "SIGKILL");
    } catch {
      // Fall through if the process group disappeared or cannot be signalled.
    }
  }
  return child.kill("SIGKILL");
}

function makeLive(environment: DesktopEnvironment.DesktopEnvironment["Service"]) {
  const dashboardPath = NodePath.join(environment.homeDirectory, ".lastcode", "dashboard.json");
  const buildLogPath = NodePath.join(
    environment.homeDirectory,
    ".lastcode",
    "local-updates",
    "build.log",
  );

  const readRepository = (): {
    readonly repoRoot: string;
    readonly helperPath: string;
    readonly installerPath: string;
  } => {
    try {
      const { repoRoot } = decodeDashboardConfig(NodeFS.readFileSync(dashboardPath, "utf8"));
      const helperPath = NodePath.join(repoRoot, "scripts", "lastcode-local-update.mjs");
      const installerPath = NodePath.join(repoRoot, "scripts", "lastcode-install.mjs");
      if (!NodeFS.existsSync(helperPath)) {
        throw new Error(`Local update helper is missing at ${helperPath}.`);
      }
      if (!NodeFS.existsSync(installerPath)) {
        throw new Error(`Local install helper is missing at ${installerPath}.`);
      }
      return { repoRoot, helperPath, installerPath };
    } catch (cause) {
      throw new LastCodeLocalUpdateError({
        operation: "configuration",
        message: `LastCode local update automation is not ready. Run the documented service and dashboard installers. (${dashboardPath})`,
        cause,
      });
    }
  };

  const runHelper = (
    operation: "inspect" | "build",
    args: ReadonlyArray<string>,
    onProgress?: (progress: LastCodeLocalBuildProgress) => Effect.Effect<void>,
  ): Effect.Effect<unknown, LastCodeLocalUpdateError> => {
    const helperEffect = Effect.tryPromise({
      try: (signal) => {
        const { repoRoot, helperPath } = readRepository();
        return new Promise<string>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [
              helperPath,
              operation,
              "--repo",
              repoRoot,
              "--home",
              environment.homeDirectory,
              ...args,
            ],
            {
              cwd: repoRoot,
              detached: usesDetachedHelperProcessGroup(environment.platform),
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout = `${stdout}${chunk}`.slice(-256_000);
          });
          child.stderr.on("data", (chunk: string) => {
            stderr = `${stderr}${chunk}`.slice(-32_000);
          });
          const abort = () => terminateHelperProcess(child, environment.platform);
          signal.addEventListener("abort", abort, { once: true });
          child.once("error", reject);
          child.once("close", (exitCode) => {
            signal.removeEventListener("abort", abort);
            if (exitCode === 0) resolve(stdout);
            else
              reject(new Error(stderr.trim() || `Local updater helper exited with ${exitCode}.`));
          });
        });
      },
      catch: (cause) =>
        isLastCodeLocalUpdateError(cause)
          ? cause
          : new LastCodeLocalUpdateError({
              operation,
              message:
                cause instanceof Error ? cause.message : `LastCode local ${operation} failed.`,
              cause,
            }),
    });

    const monitoredHelper = onProgress
      ? monitorLocalBuildProgress(buildLogPath, helperEffect, onProgress)
      : helperEffect;

    return monitoredHelper.pipe(
      Effect.flatMap((raw) =>
        Effect.try({
          try: () => parseHelperResult(raw),
          catch: (cause) =>
            new LastCodeLocalUpdateError({
              operation,
              message: `Could not read the LastCode local ${operation} result.`,
              cause,
            }),
        }),
      ),
    );
  };

  const prepareInstall = (args: {
    readonly dmgPath: string;
    readonly dmgSha256: string;
    readonly expectedVersion: string;
  }): Effect.Effect<LastCodeLocalInstallHandoff, LastCodeLocalUpdateError> => {
    const installLogPath = NodePath.join(
      environment.homeDirectory,
      ".lastcode",
      "local-updates",
      "install.log",
    );
    return Effect.tryPromise({
      try: (signal) => {
        const { repoRoot, installerPath } = readRepository();
        NodeFS.mkdirSync(NodePath.dirname(installLogPath), { recursive: true });
        const logFd = NodeFS.openSync(installLogPath, "a", 0o600);
        let child: NodeChildProcess.ChildProcess;
        try {
          child = NodeChildProcess.spawn(
            process.execPath,
            [
              installerPath,
              "handoff",
              "--dmg",
              args.dmgPath,
              "--expected-sha256",
              args.dmgSha256,
              "--expected-version",
              args.expectedVersion,
              "--parent-pid",
              String(process.pid),
              "--ready-fd",
              "3",
            ],
            {
              cwd: repoRoot,
              detached: usesDetachedHelperProcessGroup(environment.platform),
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              stdio: ["pipe", logFd, logFd, "pipe"],
            },
          );
        } finally {
          NodeFS.closeSync(logFd);
        }
        const abort = () => {
          if (child.stdin?.writable) {
            child.stdin.end("CANCEL\n");
            return;
          }
          terminateHelperProcess(child, environment.platform);
        };
        signal.addEventListener("abort", abort, { once: true });

        return new Promise<LastCodeLocalInstallHandoff>((resolve, reject) => {
          const readyStream = child.stdio[3];
          const control = child.stdin;
          let ready = false;
          let buffer = "";
          let commandSent = false;
          let preflightTimedOut = false;
          const preflightTimeoutError = () =>
            new Error(
              `Local install preflight did not finish within 2 minutes. Cleanup completed before returning. See ${installLogPath}.`,
            );
          const preflightTimeout = setTimeout(() => {
            if (ready) return;
            preflightTimedOut = true;
            control?.end("CANCEL\n");
          }, 120_000);
          const failBeforeReady = (cause: unknown) => {
            if (ready) return;
            clearTimeout(preflightTimeout);
            signal.removeEventListener("abort", abort);
            reject(cause);
          };
          child.once("error", failBeforeReady);
          child.once("close", (exitCode) => {
            failBeforeReady(
              preflightTimedOut
                ? preflightTimeoutError()
                : new Error(
                    `Local install helper exited before readiness with code ${exitCode}. See ${installLogPath}.`,
                  ),
            );
          });
          if (!(readyStream instanceof NodeStream.Readable) || !control) {
            terminateHelperProcess(child, environment.platform);
            failBeforeReady(new Error("Local install helper pipes were not created."));
            return;
          }
          readyStream.setEncoding("utf8");
          readyStream.on("data", (chunk: string) => {
            if (ready) return;
            buffer += chunk;
            if (buffer.length > 8_192) {
              terminateHelperProcess(child, environment.platform);
              failBeforeReady(new Error("Local install readiness result was too large."));
              return;
            }
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            if (preflightTimedOut) return;
            try {
              const line = buffer.slice(0, newline);
              if (!line.startsWith(INSTALL_READY_PREFIX)) {
                throw new Error("Local install helper returned an invalid readiness result.");
              }
              const result = decodeInstallReadyResult(
                JSON.parse(line.slice(INSTALL_READY_PREFIX.length)),
              );
              if (
                NodePath.resolve(result.artifactPath) !== NodePath.resolve(args.dmgPath) ||
                result.version !== args.expectedVersion
              ) {
                throw new Error("Local install helper accepted a different artifact or version.");
              }
              ready = true;
              clearTimeout(preflightTimeout);
              signal.removeEventListener("abort", abort);
              readyStream.destroy();

              const sendCommand = (
                command: "COMMIT" | "CANCEL",
              ): Effect.Effect<void, LastCodeLocalUpdateError> =>
                Effect.tryPromise({
                  try: () =>
                    new Promise<void>((done, fail) => {
                      if (commandSent) {
                        done();
                        return;
                      }
                      commandSent = true;
                      control.once("error", fail);
                      control.end(`${command}\n`, () => {
                        child.unref();
                        done();
                      });
                    }),
                  catch: (cause) =>
                    new LastCodeLocalUpdateError({
                      operation: "install",
                      message: `Could not transfer local install ownership. See ${installLogPath}.`,
                      cause,
                    }),
                });

              resolve({
                commit: sendCommand("COMMIT"),
                cancel: sendCommand("CANCEL").pipe(Effect.ignore),
              });
            } catch (cause) {
              control.end("CANCEL\n");
              failBeforeReady(cause);
            }
          });
          readyStream.once("error", (cause) => {
            if (!preflightTimedOut) failBeforeReady(cause);
          });
          control.once("error", (cause) => {
            if (!preflightTimedOut) failBeforeReady(cause);
          });
          readyStream.once("close", () => {
            if (!ready && !preflightTimedOut) {
              failBeforeReady(
                new Error(`Local install helper closed its readiness pipe. See ${installLogPath}.`),
              );
            }
          });
        });
      },
      catch: (cause) =>
        isLastCodeLocalUpdateError(cause)
          ? cause
          : new LastCodeLocalUpdateError({
              operation: "install",
              message:
                cause instanceof Error
                  ? cause.message
                  : "Could not prepare the local LastCode install.",
              cause,
            }),
    });
  };

  return LastCodeLocalUpdates.of({
    supported:
      environment.isPackaged &&
      environment.platform === "darwin" &&
      environment.runtimeInfo.hostArch === "arm64",
    buildLogPath,
    inspect: (currentVersion) =>
      runHelper("inspect", groupedInspectionArgs(currentVersion)).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => decodeInspectionResult(result),
            catch: (cause) =>
              new LastCodeLocalUpdateError({
                operation: "inspect",
                message: "The LastCode local update inspection result was invalid.",
                cause,
              }),
          }),
        ),
      ),
    build: (checkpointTag, onProgress) =>
      runHelper("build", ["--checkpoint", checkpointTag], onProgress).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => decodeBuildResult(result),
            catch: (cause) =>
              new LastCodeLocalUpdateError({
                operation: "build",
                message: "The LastCode local build result was invalid.",
                cause,
              }),
          }),
        ),
      ),
    prepareInstall,
  });
}

export const layer = Layer.effect(
  LastCodeLocalUpdates,
  Effect.map(DesktopEnvironment.DesktopEnvironment, makeLive),
);

export const layerTest = (service: LastCodeLocalUpdates["Service"]) =>
  Layer.succeed(LastCodeLocalUpdates, service);
