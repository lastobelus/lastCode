// @effect-diagnostics nodeBuiltinImport:off - uses an isolated ephemeral HTTP listener to verify the issued CLI endpoint.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import {
  DeviceId,
  DeviceHostId,
  ProjectId,
  ThreadId,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceAgentAccess from "./DeviceAgentAccess.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHost from "./DeviceHost.ts";

const decodeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ daemonBaseUrl: Schema.String, daemonAuthToken: Schema.String }),
  ),
);
const projectId = ProjectId.make("project-1");
const settings = Layer.mock(ServerSettings.ServerSettingsService)({
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    enableDeviceSupport: true,
    enableAgentDeviceAccess: false,
    projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } },
  }),
  subscribeChanges: Effect.succeed(Stream.empty),
});
const access = DeviceAgentAccess.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () =>
        Effect.succeed({ projectId, deletedAt: null } as NonNullable<
          Effect.Success<ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>>
        >),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeed(Option.some({ deletedAt: null } as ProjectStore.ProjectRow)),
    }),
  ),
  Layer.provide(settings),
);
const host = Layer.mock(DeviceHost.DeviceHost)({
  id: "local",
  summary: Effect.succeed({
    id: "local",
    kind: "local",
    label: "Test server",
    platforms: [{ platform: "ios", available: true }],
    hubInstalled: true,
    agentDeviceInstalled: true,
  }),
  platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
  ensureReady: () =>
    Effect.succeed({
      hub: { origin: "http://hub.example" },
      nodePath: process.execPath,
      run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    }),
  current: Effect.succeed(null),
  ensureAgentReady: () =>
    Effect.succeed({
      hub: { origin: "http://hub.example" },
      nodePath: process.execPath,
      run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: {
        baseUrl: "http://daemon.example",
        token: "raw-daemon-token",
        entryPath: "/tool/cli.js",
      },
    }),
});
const layer = (
  hostname: string,
  beforeWrite: (content: string) => Effect.Effect<void> = () => Effect.void,
  http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
  ),
) =>
  Layer.effect(
    DeviceService.DeviceService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writeFileString: FileSystem.FileSystem["writeFileString"] = (file, content, options) =>
        file.includes("/device/agent-threads/")
          ? beforeWrite(content).pipe(Effect.andThen(fs.writeFileString(file, content, options)))
          : fs.writeFileString(file, content, options);
      return yield* DeviceService.make.pipe(
        Effect.provideService(FileSystem.FileSystem, { ...fs, writeFileString }),
      );
    }),
  ).pipe(
    Layer.provideMerge(access),
    Layer.provide(host),
    Layer.provide(settings),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(NetService.layer),
    Layer.provideMerge(
      NodeHttpServer.layer(() => NodeHttp.createServer(), { host: hostname, port: 0 }),
    ),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-agent-config-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect.each(["127.0.0.1", "::1"])(
  "issues isolated thread/device proxy configs using the actual %s HTTP listener",
  (hostname) =>
    Effect.gen(function* () {
      const devices = yield* DeviceService.DeviceService;
      const access = yield* DeviceAgentAccess.DeviceAgentAccess;
      const server = yield* HttpServer.HttpServer;
      const fs = yield* FileSystem.FileSystem;
      const args = yield* devices.agentTarget({
        threadId: ThreadId.make("thread-1"),
        hostId: "local",
        deviceId: DeviceId.make("device-1"),
        agentAccessEnabled: true,
      });
      const config = decodeConfig(yield* fs.readFileString(args[1]!));
      expect(typeof server.address).toBe("object");
      if (typeof server.address === "string" || !("port" in server.address))
        throw new Error("Expected HTTP listener");
      expect(server.address.port).toBeGreaterThan(0);
      expect(config.daemonBaseUrl).toBe(
        `http://${hostname === "::1" ? "[::1]" : hostname}:${server.address.port}/api/agent-device`,
      );
      expect(config.daemonAuthToken).not.toBe("raw-daemon-token");
      expect(yield* access.authorize(config.daemonAuthToken)).toMatchObject({
        threadId: "thread-1",
        hostId: "local",
        deviceId: "device-1",
        session: args[3],
      });
      const otherThread = yield* devices.agentTarget({
        threadId: ThreadId.make("thread-2"),
        hostId: "local",
        deviceId: DeviceId.make("device-1"),
        agentAccessEnabled: true,
      });
      const otherDevice = yield* devices.agentTarget({
        threadId: ThreadId.make("thread-1"),
        hostId: "local",
        deviceId: DeviceId.make("device-2"),
        agentAccessEnabled: true,
      });
      expect(new Set([args[1], otherThread[1], otherDevice[1]]).size).toBe(3);
      expect(decodeConfig(yield* fs.readFileString(args[1]!))).toEqual(config);
    }).pipe(Effect.provide(layer(hostname)), Effect.scoped),
);

it.effect("thread deletion waits for an issued config write before removing it", () =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let issuedToken = "";
    const writeGate = (content: string) =>
      Effect.sync(() => {
        issuedToken = decodeConfig(content).daemonAuthToken;
      }).pipe(
        Effect.andThen(Deferred.succeed(writing, undefined)),
        Effect.andThen(Deferred.await(resume)),
        Effect.asVoid,
      );
    yield* Effect.gen(function* () {
      const devices = yield* DeviceService.DeviceService;
      const access = yield* DeviceAgentAccess.DeviceAgentAccess;
      const fs = yield* FileSystem.FileSystem;
      const threadId = ThreadId.make("thread-1");
      const writer = yield* devices
        .agentTarget({
          threadId,
          hostId: "local",
          deviceId: DeviceId.make("device-1"),
          agentAccessEnabled: true,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      let cleaned = false;
      const cleanup = yield* devices.retireThreadAgentAccess(threadId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cleaned = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      expect(cleaned).toBe(false);
      yield* Deferred.succeed(resume, undefined);
      const args = yield* Fiber.join(writer);
      yield* Fiber.join(cleanup);
      expect(yield* fs.exists(args[1]!)).toBe(false);
      expect((yield* Effect.exit(access.authorize(issuedToken)))._tag).toBe("Failure");
      const fresh = yield* devices.agentTarget({
        threadId,
        hostId: "local",
        deviceId: DeviceId.make("device-1"),
        agentAccessEnabled: true,
      });
      const config = decodeConfig(yield* fs.readFileString(fresh[1]!));
      expect((yield* access.authorize(config.daemonAuthToken)).threadId).toBe(threadId);
    }).pipe(Effect.provide(layer("127.0.0.1", writeGate)), Effect.scoped);
  }),
);

it.effect.each([
  { operation: "shutdown", platform: "android", outcome: "accepted" },
  { operation: "close", platform: "android", outcome: "accepted" },
  { operation: "shutdown", platform: "ios", outcome: "already-off" },
  { operation: "shutdown", platform: "android", outcome: "failed" },
  { operation: "shutdown", platform: "ios", outcome: "failed" },
  { operation: "close", platform: "android", outcome: "ordinary-close" },
] as const)(
  "$operation $platform $outcome retires only credentials for an accepted device shutdown",
  ({ operation, platform, outcome }) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("emulator-5554");
      const threadId = ThreadId.make("thread-1");
      let booted = true;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path === "/api/devices") {
            const device = {
              id: deviceId,
              name: "Test device",
              platform,
              version: "26",
              physical: false,
              booted,
            };
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: platform === "android" ? [device] : [],
                simulators: platform === "ios" ? [device] : [],
              }),
            );
          }
          if (path.endsWith("/shutdown")) {
            if (outcome === "already-off") booted = false;
            if (outcome === "failed" || outcome === "already-off") {
              return HttpClientResponse.fromWeb(request, Response.json({ ok: false }));
            }
            booted = false;
          } else if (path === "/api/devices/boot") booted = true;
          else if (path !== "/vendor/serve-sim/grid/api/start") {
            throw new Error(`Unexpected hub path: ${path}`);
          }
          return HttpClientResponse.fromWeb(request, Response.json({ ok: true, id: deviceId }));
        }),
      );
      yield* Effect.gen(function* () {
        const devices = yield* DeviceService.DeviceService;
        const access = yield* DeviceAgentAccess.DeviceAgentAccess;
        const fs = yield* FileSystem.FileSystem;
        const input = { threadId, hostId: "local" as const, deviceId, platform };
        yield* devices.open(input);
        const issueConfig = Effect.gen(function* () {
          const args = yield* devices.agentTarget({ ...input, agentAccessEnabled: true });
          return decodeConfig(yield* fs.readFileString(args[1]!)).daemonAuthToken;
        });
        const token = yield* issueConfig;
        const target = yield* access.authorize(token);
        const resource = { kind: "artifact" as const, id: "old-artifact" };
        const upload = { kind: "upload" as const, id: "old-upload" };
        yield* access.recordResource(target, resource);
        yield* access.recordResource(target, upload);
        const otherThreadToken = yield* access.issue({
          ...target,
          threadId: ThreadId.make("thread-2"),
          session: "other-thread",
        });
        const otherDeviceToken = yield* access.issue({
          ...target,
          deviceId: DeviceId.make("emulator-5556"),
          session: "other-device",
        });
        const otherHostToken = yield* access.issue({
          ...target,
          hostId: DeviceHostId.make("other-host"),
          session: "other-host",
        });
        const unrelatedTarget = yield* access.authorize(otherDeviceToken);
        const unrelatedResource = { kind: "artifact" as const, id: "unrelated-artifact" };
        yield* access.recordResource(unrelatedTarget, unrelatedResource);
        const exit = yield* Effect.exit(
          operation === "shutdown"
            ? devices.shutdown(input)
            : devices.close({ ...input, shutdown: outcome !== "ordinary-close" }),
        );
        expect(exit._tag).toBe(outcome === "failed" ? "Failure" : "Success");
        const retired = outcome === "accepted" || outcome === "already-off";
        for (const oldToken of [token, otherThreadToken]) {
          expect((yield* Effect.exit(access.authorize(oldToken)))._tag).toBe(
            retired ? "Failure" : "Success",
          );
        }
        for (const oldResource of [resource, upload]) {
          expect(yield* access.ownsResource(target, oldResource)).toBe(!retired);
        }
        expect(yield* access.authorize(otherDeviceToken, unrelatedResource)).toEqual(
          unrelatedTarget,
        );
        expect((yield* access.authorize(otherHostToken)).hostId).toBe("other-host");
        if (retired) {
          yield* devices.open(input);
          const freshToken = yield* issueConfig;
          expect(freshToken).not.toBe(token);
          expect((yield* access.authorize(freshToken)).deviceId).toBe(deviceId);
          for (const oldResource of [resource, upload]) {
            expect((yield* Effect.exit(access.authorize(freshToken, oldResource)))._tag).toBe(
              "Failure",
            );
          }
          expect((yield* Effect.exit(access.authorize(token)))._tag).toBe("Failure");
        } else {
          expect(yield* access.authorize(token, resource)).toEqual(target);
        }
      }).pipe(Effect.provide(layer("127.0.0.1", undefined, http)), Effect.scoped);
    }),
);
