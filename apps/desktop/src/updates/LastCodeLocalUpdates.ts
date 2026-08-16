// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only service launches local build tooling and serves its updater artifacts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";

const InspectionResult = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    status: Schema.Literal("up-to-date"),
    checkpointTag: Schema.String,
    availableVersion: Schema.String,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    status: Schema.Literal("available"),
    checkpointTag: Schema.String,
    availableVersion: Schema.String,
    releaseNotes: Schema.Array(Schema.String),
  }),
]);
export type LastCodeLocalUpdateInspection = typeof InspectionResult.Type;

const BuildResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("built"),
  checkpointTag: Schema.String,
  outputDir: Schema.String,
  manifestPath: Schema.String,
});
export type LastCodeLocalUpdateBuild = typeof BuildResult.Type;

const DashboardConfig = Schema.Struct({ repoRoot: Schema.String });
const decodeDashboardConfig = Schema.decodeUnknownSync(Schema.fromJsonString(DashboardConfig));
const decodeInspectionResult = Schema.decodeUnknownSync(InspectionResult);
const decodeBuildResult = Schema.decodeUnknownSync(BuildResult);

export class LastCodeLocalUpdateError extends Schema.TaggedErrorClass<LastCodeLocalUpdateError>()(
  "LastCodeLocalUpdateError",
  {
    operation: Schema.Literals(["configuration", "inspect", "build", "serve"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface LastCodeLocalUpdateFeed {
  readonly url: string;
  readonly close: Effect.Effect<void>;
}

export class LastCodeLocalUpdates extends Context.Service<
  LastCodeLocalUpdates,
  {
    readonly supported: boolean;
    readonly inspect: (
      currentVersion: string,
    ) => Effect.Effect<LastCodeLocalUpdateInspection, LastCodeLocalUpdateError>;
    readonly build: (
      checkpointTag: string,
    ) => Effect.Effect<LastCodeLocalUpdateBuild, LastCodeLocalUpdateError>;
    readonly startFeed: (
      outputDir: string,
    ) => Effect.Effect<LastCodeLocalUpdateFeed, LastCodeLocalUpdateError>;
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

function contentType(path: string): string {
  if (path.endsWith(".yml")) return "text/yaml; charset=utf-8";
  if (path.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

export function isSafeFeedArtifactName(name: string): boolean {
  return (
    NodePath.basename(name) === name &&
    (name === "nightly-mac.yml" ||
      name.endsWith(".zip") ||
      name.endsWith(".zip.blockmap") ||
      name.endsWith(".dmg") ||
      name.endsWith(".dmg.blockmap"))
  );
}

export function usesDetachedHelperProcessGroup(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
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

  const readRepository = (): { readonly repoRoot: string; readonly helperPath: string } => {
    try {
      const { repoRoot } = decodeDashboardConfig(NodeFS.readFileSync(dashboardPath, "utf8"));
      const helperPath = NodePath.join(repoRoot, "scripts", "lastcode-local-update.mjs");
      if (!NodeFS.existsSync(helperPath)) {
        throw new Error(`Local update helper is missing at ${helperPath}.`);
      }
      return { repoRoot, helperPath };
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
  ): Effect.Effect<unknown, LastCodeLocalUpdateError> =>
    Effect.tryPromise({
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
    }).pipe(
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

  return LastCodeLocalUpdates.of({
    supported:
      environment.isPackaged &&
      environment.platform === "darwin" &&
      environment.runtimeInfo.hostArch === "arm64",
    inspect: (currentVersion) =>
      runHelper("inspect", ["--current-version", currentVersion]).pipe(
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
    build: (checkpointTag) =>
      runHelper("build", ["--checkpoint", checkpointTag]).pipe(
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
    startFeed: (outputDir) =>
      Effect.tryPromise({
        try: () =>
          new Promise<LastCodeLocalUpdateFeed>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              if (request.method !== "GET" && request.method !== "HEAD") {
                response.writeHead(405).end();
                return;
              }
              let name: string;
              try {
                name = decodeURIComponent(
                  new URL(request.url ?? "/", "http://localhost").pathname.slice(1),
                );
              } catch {
                response.writeHead(400).end();
                return;
              }
              if (!isSafeFeedArtifactName(name)) {
                response.writeHead(404).end();
                return;
              }
              const artifactPath = NodePath.join(outputDir, name);
              let stat: NodeFS.Stats;
              try {
                stat = NodeFS.lstatSync(artifactPath);
                if (!stat.isFile()) throw new Error("not a file");
              } catch {
                response.writeHead(404).end();
                return;
              }
              response.writeHead(200, {
                "Content-Type": contentType(name),
                "Content-Length": stat.size,
                "Cache-Control": "no-store",
              });
              if (request.method === "HEAD") response.end();
              else NodeFS.createReadStream(artifactPath).pipe(response);
            });
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                server.close();
                reject(new Error("Local update server did not bind a TCP port."));
                return;
              }
              resolve({
                url: `http://127.0.0.1:${address.port}`,
                close: Effect.promise(
                  () => new Promise<void>((done) => server.close(() => done())),
                ),
              });
            });
          }),
        catch: (cause) =>
          new LastCodeLocalUpdateError({
            operation: "serve",
            message: "Could not stage the locally built LastCode update.",
            cause,
          }),
      }),
  });
}

export const layer = Layer.effect(
  LastCodeLocalUpdates,
  Effect.map(DesktopEnvironment.DesktopEnvironment, makeLive),
);

export const layerTest = (service: LastCodeLocalUpdates["Service"]) =>
  Layer.succeed(LastCodeLocalUpdates, service);
