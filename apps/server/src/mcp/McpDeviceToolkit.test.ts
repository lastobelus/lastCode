import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceHostUnavailableError,
  DeviceId,
  ProjectId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-device-test");
const threadId = ThreadId.make("thread-device-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-device-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-device-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const device = {
  hostId: "local",
  id: "UDID-1",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};
const state = {
  hosts: [
    {
      id: "local",
      kind: "local" as const,
      label: "This machine",
      platforms: [
        { platform: "ios" as const, available: true },
        { platform: "android" as const, available: false, reason: "No SDK" },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready" as const,
  hostStatuses: { local: { status: "ready" as const } },
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 1206);
new DataView(png.buffer).setUint32(20, 2622);

const layerDeviceServiceMock = Layer.mock(DeviceService.DeviceService)({
  state: Effect.succeed(state),
  list: Effect.succeed(state),
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      hostId: "local",
      deviceId: input.deviceId,
      platform: input.platform,
      openedAt: "2026-09-08T00:00:00.000Z",
    }),
  // UDID-1 is open in the test thread; UDID-2 exists but belongs to another thread.
  sessionsForThread: (id) =>
    Effect.succeed(
      id === threadId
        ? [
            {
              threadId,
              hostId: "local",
              deviceId: DeviceId.make("UDID-1"),
              platform: "ios" as const,
              openedAt: "2026-09-08T00:00:00.000Z",
            },
          ]
        : [],
    ),
  screenshot: () => Effect.succeed({ device, png }),
  close: () => Effect.void,
  agentCli: Effect.succeed("/cli"),
  testHost: () => Effect.die("not used"),
  agentTarget: () => Effect.succeed(["--config", "/host.json", "--session", "thread-device"]),
});

const projectId = ProjectId.make("project:mcp-test");
const project: ProjectStore.ProjectRow = {
  projectId,
  title: "Device test project",
  workspaceRoot: "/test/project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};
const allowedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  enableDeviceSupport: true,
  enableAgentDeviceAccess: true,
};
const layerAccess = Layer.mergeAll(
  Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.some(project)) }),
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed(allowedSettings),
  }),
);

const layerTest = McpHttpServer.layerDeviceToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerDeviceServiceMock),
  Layer.provide(layerAccess),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("registers the device tools and returns the screenshot as image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name).toSorted();
      expect(names).toEqual(["device_close", "device_list", "device_open", "device_screenshot"]);

      const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities));

      const opened = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(opened.isError).toBe(false);
      const openedContent = opened.structuredContent as { quickStart: string };
      expect(openedContent.quickStart).toContain("--udid UDID-1");

      const shot = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-1" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const foreign = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-2" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(foreign.isError).toBe(true);
      expect(foreign.content.map((entry) => entry.type)).toEqual(["text"]);

      const denied = yield* server
        .callTool({ name: "device_list", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const layerUnavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentTarget: () =>
      Effect.fail(
        new DeviceHostUnavailableError({ hostId: "local", reason: "Agent access is disabled." }),
      ),
    open: () => Effect.die("Must not boot or register a device when agent access fails"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Agent access is disabled."),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerUnavailable),
        Layer.provide(layerAccess),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect.each([
  { name: "environment revocation", globalAccess: true, projectAccess: undefined },
  { name: "project revocation with the environment off", globalAccess: false, projectAccess: true },
])("rejects the same device credential after $name", ({ globalAccess, projectAccess }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const availableProject = yield* Ref.make(Option.some(project));
      const settings = yield* Ref.make({
        ...DEFAULT_SERVER_SETTINGS,
        enableDeviceSupport: true,
        enableAgentDeviceAccess: globalAccess,
        projectSettingsOverrides: {
          [projectId]:
            projectAccess === undefined ? {} : { enableAgentDeviceAccess: projectAccess },
        },
      });
      const operations: string[] = [];
      const observedService = Layer.mock(DeviceService.DeviceService)({
        state: Effect.succeed(state),
        list: Effect.sync(() => {
          operations.push("list");
          return state;
        }),
        agentTarget: () =>
          Effect.sync(() => {
            operations.push("agent helper");
            return ["--config", "/host.json", "--session", "thread-device"];
          }),
        open: (input) =>
          Effect.sync(() => {
            operations.push("open");
            return {
              threadId: input.threadId,
              hostId: "local",
              deviceId: input.deviceId,
              platform: input.platform,
              openedAt: "2026-09-08T00:00:00.000Z",
            };
          }),
        agentCli: Effect.succeed("/cli"),
        sessionsForThread: () =>
          Effect.sync(() => {
            operations.push("device sessions");
            return [];
          }),
        close: () =>
          Effect.sync(() => {
            operations.push("close");
          }),
      });
      const dependencies = Layer.mergeAll(
        observedService,
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Ref.get(availableProject) }),
        Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Ref.get(settings) }),
      );
      const server = yield* McpServer.McpServer.pipe(
        Effect.provide(
          McpHttpServer.layerDeviceToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(dependencies),
          ),
        ),
      );
      const credential = invocation(["device"]);
      const call = (name: string, args = {}) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, credential),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(false);
      expect(operations).toEqual(["list", "agent helper", "open"]);
      yield* Ref.set(availableProject, Option.none());
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(true);
      expect(operations).toEqual(["list", "agent helper", "open"]);
      yield* Ref.set(
        availableProject,
        Option.some({ ...project, deletedAt: "2026-10-01T00:00:00.000Z" }),
      );
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(true);
      expect(operations).toEqual(["list", "agent helper", "open"]);
      yield* Ref.set(availableProject, Option.some(project));
      yield* Ref.update(settings, (current) => ({
        ...current,
        enableAgentDeviceAccess: false,
        projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: false } },
      }));
      for (const name of ["device_open", "device_list", "device_screenshot", "device_close"]) {
        const denied = yield* call(name, name === "device_open" ? { platform: "ios" } : {});
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(
                name === "device_screenshot"
                  ? "Device screenshot failed."
                  : "Agent device access is turned off",
              ),
            }),
          ]),
        );
      }
      expect(operations).toEqual(["list", "agent helper", "open"]);
    }),
  ).pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-revoke-" })),
    Effect.provide(NodeServices.layer),
  ),
);
