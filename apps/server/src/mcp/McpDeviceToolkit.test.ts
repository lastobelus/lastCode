import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceHostUnavailableError,
  DeviceOperationError,
  DeviceToolUnavailableError,
  type DeviceSession,
  DeviceId,
  ProjectId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { ensureAgentDeviceShim } from "../device/AgentDeviceShim.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ProjectService from "../project/ProjectService.ts";
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

const unused = Effect.die("not used");
const readiness = {
  hostId: "local",
  nodePath: process.execPath,
  hub: { origin: "http://hub.test" },
  devices: {
    list: unused,
    boot: () => unused,
    attach: () => unused,
    shutdown: () => unused,
    screenshot: () => unused,
  },
  run: () => unused,
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  agentDevice: null,
};
const layerProjectsMock = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const openSession = {
  threadId,
  hostId: "local",
  deviceId: DeviceId.make("UDID-1"),
  platform: "ios" as const,
  openedAt: "2026-09-08T00:00:00.000Z",
};
const agentReady: DeviceService.DeviceAgentReadiness = {
  hostId: "local",
  nodePath: "/node",
  devices: readiness.devices,
  hub: { origin: "http://localhost:4100" },
  run: () => Effect.die("not used"),
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  agentDevice: {
    baseUrl: "http://localhost:4101",
    token: "test-agent-token",
    entryPath: "/cli",
  },
};

const layerDeviceServiceMock = Layer.mock(DeviceService.DeviceService)({
  state: Effect.succeed(state),
  list: Effect.succeed(state),
  completeOpen: () => Effect.void,
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      hostId: "local",
      deviceId: input.deviceId,
      platform: input.platform,
      openedAt: "2026-09-08T00:00:00.000Z",
    }),

  sessionsForThread: (id) => Effect.succeed(id === threadId ? [openSession] : []),
  locateSession: (input) =>
    Effect.succeed(
      input.threadId === threadId && input.deviceId === openSession.deviceId
        ? Option.some(openSession)
        : Option.none(),
    ),
  screenshot: () => Effect.succeed({ device, png }),
  close: () => Effect.void,
  testHost: () => Effect.die("not used"),
  agentReadinessIfSupported: () => Effect.succeed(agentReady),
  // As for an EAS device, agent-device knows the device by a different id than T3.
  agentTarget: () =>
    Effect.succeed({
      agentDeviceId: "SIM-UDID",
      session: "thread-device",
      args: ["--config", "/host.json", "--session", "thread-device"],
    }),
  agentLauncher: ({ targetArgs }) =>
    Effect.succeedSome(`/state/device/targets/thread-device/${targetArgs.join("_")}/agent-device`),
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
  McpToolAccessTestkit.liveThreadProjectionsLayer,
  Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedSome(project) }),
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
  Layer.provide(layerProjectsMock),
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
      const openedContent = opened.structuredContent as {
        agentDevice: { command: string; targetArgs: ReadonlyArray<string>; session: string };
        quickStart: string;
      };
      // Callers that pass the target flags, like test-t3-mobile's pair-client.sh, keep working.
      expect(openedContent.agentDevice).toMatchObject({
        targetArgs: [
          "--platform",
          "ios",
          "--udid",
          "SIM-UDID",
          "--config",
          "/host.json",
          "--session",
          "thread-device",
        ],
        session: "thread-device",
      });
      expect(openedContent.quickStart).toContain(
        `${openedContent.agentDevice.command} snapshot -i`,
      );
      // The launcher selects the device by agent-device's id for it, not T3's.
      expect(openedContent.agentDevice.command).toBe(
        "/state/device/targets/thread-device/--platform_ios_--udid_SIM-UDID_--config_/host.json_--session_thread-device/agent-device",
      );

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
      // The agent can't see Settings, and a running session keeps the capabilities it started with,
      // so the error says where the user turns access on and when it applies.
      expect(denied.content).toEqual([
        {
          type: "text",
          text: "Agent device access is turned off for this environment. Ask the user to turn on Agent device access in Settings > Integrations > Devices; it applies when the agent session next starts, such as in a new thread.",
        },
      ]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  {
    name: "stopped Android AVD",
    selected: "Pixel_API_35",
    opened: "emulator-5554",
    platform: "android" as const,
    refreshed: true,
  },
  {
    name: "Android AVD with a stale device list",
    selected: "Pixel_API_35",
    opened: "emulator-5554",
    platform: "android" as const,
    refreshed: false,
  },
  {
    name: "running Android emulator",
    selected: "emulator-5554",
    opened: "emulator-5554",
    platform: "android" as const,
    refreshed: true,
  },
  {
    name: "iOS simulator",
    selected: "UDID-1",
    opened: "UDID-1",
    platform: "ios" as const,
    refreshed: true,
  },
])(
  "issues the device credential for the opened $name",
  ({ selected, opened, platform, refreshed }) => {
    const selectedDevice = { ...device, id: selected, platform, booted: selected === opened };
    const openedDevice = { ...selectedDevice, id: opened, booted: true };
    const operations: string[] = [];
    const scopedArgs = ["--config", "/host.json", "--session", "opened-device-session"];
    const layerOpening = Layer.mock(DeviceService.DeviceService)({
      list: Effect.succeed({ ...state, devices: [selectedDevice] }),
      state: Effect.succeed({ ...state, devices: [refreshed ? openedDevice : selectedDevice] }),
      agentReadinessIfSupported: (hostId, enabled) =>
        Effect.sync(() => {
          expect(hostId).toBe("local");
          expect(enabled).toBe(true);
          operations.push("ready");
          return agentReady;
        }),
      open: (input) =>
        Effect.sync(() => {
          expect(operations).toEqual(["ready"]);
          expect(input.deviceId).toBe(selected);
          operations.push("open");
          return {
            threadId: input.threadId,
            hostId: "local",
            deviceId: DeviceId.make(opened),
            platform,
            openedAt: "2026-09-08T00:00:00.000Z",
          };
        }),
      agentTarget: (input) =>
        Effect.sync(() => {
          expect(operations).toEqual(["ready", "open"]);
          expect(input).toEqual({
            openedSession: {
              threadId,
              hostId: "local",
              deviceId: opened,
              platform,
              openedAt: "2026-09-08T00:00:00.000Z",
            },
            agentAccessEnabled: true,
          });
          operations.push("credential");
          return { agentDeviceId: opened, session: "opened-device-session", args: scopedArgs };
        }),
      agentLauncher: () => Effect.succeedSome("/state/device/targets/thread-device/agent-device"),
      abortOpen: () => Effect.die("A successful open must retain its session"),
      completeOpen: () => Effect.void,
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "device_open", arguments: { platform } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(false);
      expect(operations).toEqual(["ready", "open", "credential"]);
      const selector = platform === "android" ? "--serial" : "--udid";
      expect(result.structuredContent).toMatchObject({
        device: { id: opened, platform },
        agentDevice: { targetArgs: ["--platform", platform, selector, opened, ...scopedArgs] },
        quickStart: expect.stringContaining("It is bound to this device and session"),
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(layerOpening),
          Layer.provide(layerAccess),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-open-test-" }),
          ),
          Layer.provide(layerProjectsMock),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);

it.effect("does not boot or issue a credential when agent readiness is unsupported", () => {
  const layerUnsupported = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () => Effect.succeed(null),
    open: () => Effect.die("Must not boot without agent readiness"),
    agentTarget: () => Effect.die("Must not issue a credential without agent readiness"),
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
          text: expect.stringContaining("Agent device access requires"),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerUnsupported),
        Layer.provide(layerAccess),
        Layer.provide(layerProjectsMock),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const layerUnavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () =>
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
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" }),
        ),
        Layer.provide(layerAccess),
        Layer.provide(layerProjectsMock),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

describe("device targeting across hosts", () => {
  const macHost = {
    id: "mac-mini",
    kind: "ssh" as const,
    label: "Mac Mini",
    platforms: [
      { platform: "ios" as const, available: true },
      { platform: "android" as const, available: true },
    ],
    hubInstalled: true,
    agentDeviceInstalled: true,
  };
  const macIphone = { ...device, hostId: "mac-mini", id: "MAC-UDID" };
  const localPixel = {
    hostId: "local",
    id: "Pixel_10",
    platform: "android" as const,
    name: "Pixel 10",
    version: "Android 16",
    booted: false,
    physical: false,
  };
  const macPixel = { ...localPixel, hostId: "mac-mini" };
  const multiHostState = {
    ...state,
    hosts: [...state.hosts, macHost],
    hostStatuses: {
      local: { status: "ready" as const },
      "mac-mini": { status: "ready" as const },
    },
    devices: [device, macIphone, localPixel, macPixel],
  };
  const session = (hostId: string, deviceId: string, platform: "ios" | "android") => ({
    threadId,
    hostId,
    deviceId: DeviceId.make(deviceId),
    platform,
    openedAt: "2026-09-08T00:00:00.000Z",
  });
  const thisMachine = { id: "local", label: "This machine" };
  const macMini = { id: macHost.id, label: macHost.label };
  // DeviceService's lookup errors; DeviceService.test.ts covers when each arises.
  const onTwoHosts = new DeviceService.DeviceHostAmbiguousError({
    deviceId: DeviceId.make("Pixel_10"),
    hosts: [thisMachine, macMini],
  });
  const onTheMac = new DeviceService.DeviceOnOtherHostError({
    deviceId: DeviceId.make("MAC-UDID"),
    host: thisMachine,
    hosts: [macMini],
  });

  const run = <A, E>(
    sessions: ReadonlyArray<ReturnType<typeof session>>,
    program: (calls: {
      readonly opened: Array<{ hostId: string; deviceId: string }>;
      readonly closed: Array<{ hostId?: string | undefined; deviceId?: string | undefined }>;
      readonly call: (
        name: string,
        args: Record<string, unknown>,
      ) => Effect.Effect<
        McpSchema.CallToolResult,
        McpSchema.InternalError | McpSchema.InvalidParams,
        McpServer.McpServer
      >;
    }) => Effect.Effect<A, E, McpServer.McpServer>,
    overrides: Partial<DeviceService.DeviceService["Service"]> = {},
  ) => {
    const opened: Array<{ hostId: string; deviceId: string }> = [];
    const closed: Array<{ hostId?: string | undefined; deviceId?: string | undefined }> = [];
    const layerDevices = Layer.mock(DeviceService.DeviceService)({
      state: Effect.succeed(multiHostState),
      list: Effect.succeed(multiHostState),
      agentReadinessIfSupported: () => Effect.succeed(readiness),
      completeOpen: () => Effect.void,
      open: (input) =>
        Effect.sync(() => {
          opened.push({ hostId: input.hostId ?? "local", deviceId: input.deviceId });
          return session(input.hostId ?? "local", input.deviceId, input.platform);
        }),
      sessionsForThread: () => Effect.succeed(sessions),
      locateDevice: (input) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            multiHostState.devices.find(
              (candidate) =>
                candidate.id === input.deviceId &&
                (input.hostId === undefined || candidate.hostId === input.hostId),
            ),
          ),
        ),
      locateSession: (input) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            sessions.find(
              (candidate) =>
                candidate.deviceId === input.deviceId &&
                (input.hostId === undefined || candidate.hostId === input.hostId),
            ),
          ),
        ),
      screenshot: (target) =>
        Effect.succeed({
          device:
            multiHostState.devices.find(
              (candidate) => candidate.hostId === target.hostId && candidate.id === target.deviceId,
            ) ?? device,
          png,
        }),
      close: (input) =>
        Effect.sync(() => {
          closed.push({ hostId: input.hostId, deviceId: input.deviceId });
        }),
      agentTarget: () =>
        Effect.succeed({
          agentDeviceId: "MAC-UDID",
          session: "thread-device",
          args: ["--config", "/mac.json", "--session", "thread-device"],
        }),
      agentLauncher: () => Effect.succeedSome("/state/device/targets/thread-device/agent-device"),
      ...overrides,
    });
    const call = (name: string, args: Record<string, unknown>) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) => server.callTool({ name, arguments: args })),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    return program({ opened, closed, call }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(layerDevices),
          Layer.provide(layerProjectsMock),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  };
  const text = (result: McpSchema.CallToolResult) =>
    result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");

  it.effect("opens a device id that exists only on another host", () =>
    run([], ({ opened, call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_open", { deviceId: "MAC-UDID" });
        expect(text(result)).not.toContain("No device");
        expect(result.isError).toBe(false);
        expect(opened).toEqual([{ hostId: "mac-mini", deviceId: "MAC-UDID" }]);
      }),
    ),
  );

  it.effect("binds the launcher to the id the device booted with", () => {
    const targets: Array<string> = [];
    return run(
      [],
      ({ call }) =>
        Effect.gen(function* () {
          const result = yield* call("device_open", { deviceId: "Pixel_10", hostId: "mac-mini" });
          expect(result.isError).toBe(false);
          expect(targets).toEqual(["emulator-5554", "emulator-5554"]);
        }),
      {
        open: (input) =>
          Effect.succeed(session(input.hostId ?? "local", "emulator-5554", "android")),
        agentTarget: (target) =>
          Effect.sync(() => {
            targets.push(target.openedSession.deviceId);
            return { agentDeviceId: target.openedSession.deviceId, session: "thread-device", args: [] };
          }),
        agentLauncher: (target) =>
          Effect.sync(() => {
            targets.push(target.deviceId);
            return Option.some("/state/device/targets/thread-device/agent-device");
          }),
      },
    );
  });

  it.effect("says a device closed during device_open was closed, not that its host is down", () =>
    run(
      [],
      ({ call }) =>
        Effect.gen(function* () {
          const result = yield* call("device_open", { deviceId: "MAC-UDID" });
          expect(result.isError).toBe(true);
          expect(text(result)).toBe(
            "The device was closed while device_open was preparing it. Call device_open again only if you still need it.",
          );
        }),
      { agentLauncher: () => Effect.succeedNone },
    ),
  );

  it.effect("refuses a device id that exists on two hosts and names both", () =>
    run(
      [],
      ({ opened, call }) =>
        Effect.gen(function* () {
          const result = yield* call("device_open", { deviceId: "Pixel_10" });
          expect(result.isError).toBe(true);
          expect(text(result)).toContain("hostId local");
          expect(text(result)).toContain("hostId mac-mini");
          expect(text(result)).toBe(
            "Device Pixel_10 is on more than one host: 'This machine' (hostId local), 'Mac Mini' (hostId mac-mini). Pass hostId.",
          );
          expect(opened).toEqual([]);
        }),
      { locateDevice: () => Effect.fail(onTwoHosts) },
    ),
  );

  it.effect("keeps an explicit hostId and says which host has the device", () =>
    run(
      [],
      ({ opened, call }) =>
        Effect.gen(function* () {
          const result = yield* call("device_open", { deviceId: "MAC-UDID", hostId: "local" });
          expect(result.isError).toBe(true);
          expect(text(result)).toContain("hostId mac-mini");
          expect(text(result)).toBe(
            "Device MAC-UDID is not on 'This machine' (hostId local). It is on 'Mac Mini' (hostId mac-mini); pass that hostId.",
          );
          expect(opened).toEqual([]);
        }),
      { locateDevice: () => Effect.fail(onTheMac) },
    ),
  );

  it.effect("says no host has a device id, naming the host it was asked on", () =>
    run([], ({ opened, call }) =>
      Effect.gen(function* () {
        const missing = (args: Record<string, unknown>) =>
          call("device_open", { deviceId: "Pixel_9", ...args }).pipe(Effect.map(text));
        expect(yield* missing({})).toBe(
          "No device Pixel_9 on any host. Call device_list for current ids.",
        );
        expect(yield* missing({ hostId: "mac-mini" })).toBe(
          "No device Pixel_9 on 'Mac Mini' (hostId mac-mini). Call device_list for current ids.",
        );
        expect(yield* missing({ hostId: "unknown-host" })).toBe(
          "No device Pixel_9 on hostId unknown-host. Call device_list for current ids.",
        );
        expect(opened).toEqual([]);
      }),
    ),
  );

  it.effect("screenshots an open device by id on whichever host it is on", () =>
    run([session("mac-mini", "MAC-UDID", "ios")], ({ call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_screenshot", { deviceId: "MAC-UDID" });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({ device: { hostId: "mac-mini" } });
      }),
    ),
  );

  it.effect("says why device_screenshot failed instead of a generic error", () =>
    run(
      [session("mac-mini", "MAC-UDID", "ios")],
      ({ call }) =>
        Effect.gen(function* () {
          const wrongHost = yield* call("device_screenshot", {
            deviceId: "MAC-UDID",
            hostId: "local",
          });
          expect(wrongHost.isError).toBe(true);
          expect(text(wrongHost)).toContain("It is on 'Mac Mini' (hostId mac-mini)");
          expect(text(wrongHost)).toBe(
            "Device MAC-UDID is not on 'This machine' (hostId local). It is on 'Mac Mini' (hostId mac-mini); pass that hostId.",
          );
        }),
      { locateSession: () => Effect.fail(onTheMac) },
    ),
  );

  it.effect("tells an agent to open a device id before screenshotting it", () =>
    run([], ({ call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_screenshot", { deviceId: "MAC-UDID" });
        expect(result.isError).toBe(true);
        expect(text(result)).toBe(
          "Device MAC-UDID is not open in this thread. Call device_open first.",
        );
      }),
    ),
  );

  it.effect("tells an agent with no open device to call device_open before a screenshot", () =>
    run([], ({ call }) =>
      Effect.gen(function* () {
        const result = yield* call("device_screenshot", {});
        expect(result.isError).toBe(true);
        expect(text(result)).toBe("No device is open in this thread. Call device_open first.");
        expect(result.structuredContent).toMatchObject({
          error: { _tag: "DeviceToolUnavailableError" },
        });
      }),
    ),
  );

  it.effect("refuses to close an id open on two hosts instead of closing both", () =>
    run(
      [session("local", "Pixel_10", "android"), session("mac-mini", "Pixel_10", "android")],
      ({ closed, call }) =>
        Effect.gen(function* () {
          const result = yield* call("device_close", { deviceId: "Pixel_10" });
          expect(result.isError).toBe(true);
          expect(text(result)).toContain("hostId mac-mini");
          expect(text(result)).toBe(
            "Device Pixel_10 is on more than one host: 'This machine' (hostId local), 'Mac Mini' (hostId mac-mini). Pass hostId.",
          );
          expect(closed).toEqual([]);
        }),
      { locateSession: () => Effect.fail(onTwoHosts) },
    ),
  );

  it.effect("closes an open device on its host and treats an unopened one as closed", () =>
    run([session("mac-mini", "MAC-UDID", "ios")], ({ closed, call }) =>
      Effect.gen(function* () {
        expect((yield* call("device_close", { deviceId: "MAC-UDID" })).isError).toBe(false);
        expect((yield* call("device_close", { deviceId: "Pixel_9" })).isError).toBe(false);
        expect(closed).toEqual([
          { hostId: "mac-mini", deviceId: "MAC-UDID" },
          { hostId: undefined, deviceId: "Pixel_9" },
        ]);
      }),
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
        agentReadinessIfSupported: () => Effect.succeed(agentReady),
        agentTarget: () =>
          Effect.sync(() => {
            operations.push("agent helper");
            return {
              agentDeviceId: device.id,
              session: "thread-device",
              args: ["--config", "/host.json", "--session", "thread-device"],
            };
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
        agentLauncher: () => Effect.succeedSome("/state/device/targets/thread-device/agent-device"),
        completeOpen: () => Effect.void,
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
        McpToolAccessTestkit.liveThreadProjectionsLayer,
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
      expect(operations).toEqual(["list", "open", "agent helper"]);
      yield* Ref.set(availableProject, Option.none());
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(true);
      expect(operations).toEqual(["list", "open", "agent helper"]);
      yield* Ref.set(
        availableProject,
        Option.some({ ...project, deletedAt: "2026-10-01T00:00:00.000Z" }),
      );
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(true);
      expect(operations).toEqual(["list", "open", "agent helper"]);
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
      expect(operations).toEqual(["list", "open", "agent helper"]);
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-revoke-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect.each([
  { stage: "denied", cleanupFails: false },
  { stage: "config", cleanupFails: false },
  { stage: "cli", cleanupFails: false },
  { stage: "shim", cleanupFails: false },
  { stage: "denied", cleanupFails: true },
] as const)(
  "rolls back the exact opened session after $stage failure (cleanup failure: $cleanupFails)",
  ({ stage, cleanupFails }) => {
    const openedSession = {
      threadId,
      hostId: "local",
      deviceId: DeviceId.make("UDID-1"),
      platform: "ios" as const,
      openedAt: "2026-09-08T00:00:00.000Z",
    };
    const aborted: DeviceSession[] = [];
    const failure =
      stage === "config"
        ? new DeviceOperationError({
            operation: "configure agent",
            reason: "settings_failed",
            cause: new Error("synthetic config write failure"),
          })
        : new DeviceHostUnavailableError({
            hostId: "local",
            reason:
              stage === "cli"
                ? "Agent CLI is unavailable."
                : "Agent access was revoked during boot.",
          });
    let issued = false;
    const failingDevices = Layer.mock(DeviceService.DeviceService)({
      list: Effect.succeed(state),
      state: Effect.succeed(state),
      agentReadinessIfSupported: () => Effect.succeed(agentReady),
      open: () => Effect.succeed(openedSession),
      agentTarget: (input) =>
        Effect.gen(function* () {
          expect(input.openedSession).toBe(openedSession);
          if (stage === "denied" || stage === "config") return yield* failure;
          issued = true;
          return {
            agentDeviceId: openedSession.deviceId,
            session: "opened-device-session",
            args: ["--config", "/host.json", "--session", "opened-device-session"],
          };
        }),
      agentLauncher: () =>
        Effect.gen(function* () {
          if (stage === "cli") return yield* failure;
          const config = yield* ServerConfig.ServerConfig;
          const directory = yield* ensureAgentDeviceShim({
            entryPath: "/cli",
            stateDir: config.stateDir,
          }).pipe(
            Effect.mapError((cause) =>
              new DeviceToolUnavailableError({
                reason: "Could not prepare the agent-device launcher.",
                cause,
              }),
            ),
          );
          return Option.some(`${directory}/agent-device`);
        }),
      abortOpen: (session) =>
        Effect.gen(function* () {
          aborted.push(session);
          if (cleanupFails)
            return yield* new DeviceHostUnavailableError({
              hostId: "local",
              reason: "Synthetic cleanup failure.",
            });
        }),
      close: () => Effect.die("Rollback must use exact session identity, not stable device IDs"),
    });
    const failingShim = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const writeFileString: FileSystem.FileSystem["writeFileString"] = (
          file,
          content,
          options,
        ) =>
          stage === "shim" && file.endsWith("agent-device-launcher.mjs")
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: file,
                  }),
                ),
              )
            : fs.writeFileString(file, content, options);
        return { ...fs, writeFileString };
      }),
    ).pipe(Layer.provide(NodeServices.layer));
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
            text: expect.stringContaining(
              stage === "shim" ? "Could not prepare the agent-device launcher." : failure.message,
            ),
          }),
        ]),
      );
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toBe(openedSession);
      expect(issued).toBe(stage === "cli" || stage === "shim");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(failingDevices),
          Layer.provide(layerAccess),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-rollback-test-" }),
          ),
          Layer.provide(failingShim),
          Layer.provide(layerProjectsMock),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);

it.effect("rolls back the opened session when post-open credential issuance is interrupted", () =>
  Effect.gen(function* () {
    const issuing = yield* Deferred.make<void>();
    const openedSession = {
      threadId,
      hostId: "local",
      deviceId: DeviceId.make("UDID-1"),
      platform: "ios" as const,
      openedAt: "2026-09-08T00:00:00.000Z",
    };
    const aborted: DeviceSession[] = [];
    const delayedDevices = Layer.mock(DeviceService.DeviceService)({
      list: Effect.succeed(state),
      agentReadinessIfSupported: () => Effect.succeed(agentReady),
      open: () => Effect.succeed(openedSession),
      agentTarget: () => Deferred.succeed(issuing, undefined).pipe(Effect.andThen(Effect.never)),
      abortOpen: (session) =>
        Effect.sync(() => {
          aborted.push(session);
        }),
      close: () => Effect.die("Rollback must not close a device by stable IDs"),
    });
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const request = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.forkChild,
        );
      yield* Deferred.await(issuing);
      yield* Fiber.interrupt(request);
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toBe(openedSession);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(delayedDevices),
          Layer.provide(layerAccess),
          Layer.provide(layerProjectsMock),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }),
);

it.effect.each([
  { name: "environment access", globalAccess: true, projectAccess: undefined },
  { name: "project access", globalAccess: false, projectAccess: true },
])(
  "does not boot when $name is revoked during agent readiness",
  ({ globalAccess, projectAccess }) =>
    Effect.gen(function* () {
      const readinessStarted = yield* Deferred.make<void>();
      const resumeReadiness = yield* Deferred.make<void>();
      const settings = yield* Ref.make({
        ...allowedSettings,
        enableAgentDeviceAccess: globalAccess,
        projectSettingsOverrides:
          projectAccess === undefined
            ? {}
            : { [projectId]: { enableAgentDeviceAccess: projectAccess } },
      });
      const sessions = yield* Ref.make<ReadonlyArray<DeviceSession>>([]);
      let bootCalls = 0;
      const devices = Layer.mock(DeviceService.DeviceService)({
        list: Effect.succeed(state),
        state: Ref.get(sessions).pipe(Effect.map((sessions) => ({ ...state, sessions }))),
        agentReadinessIfSupported: () =>
          Deferred.succeed(readinessStarted, undefined).pipe(
            Effect.andThen(Deferred.await(resumeReadiness)),
            Effect.as(agentReady),
          ),
        open: (input) =>
          Effect.gen(function* () {
            bootCalls++;
            const session = {
              threadId: input.threadId,
              hostId: "local",
              deviceId: input.deviceId,
              platform: input.platform,
              openedAt: "2026-09-08T00:00:00.000Z",
            };
            yield* Ref.update(sessions, (current) => [...current, session]);
            return session;
          }),
        agentTarget: () =>
          Effect.die("Revoked access must be rejected before boot or credential issuance"),
        abortOpen: () => Effect.die("No session should be opened for revoked access"),
      });
      const access = Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        McpToolAccessTestkit.liveThreadProjectionsLayer,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome(project),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Ref.get(settings) }),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const opening = yield* server
          .callTool({ name: "device_open", arguments: { platform: "ios" } })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(["device"]),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.forkChild,
          );
        yield* Deferred.await(readinessStarted);
        yield* Ref.update(settings, (current) => ({
          ...current,
          enableAgentDeviceAccess: false,
          projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: false } },
        }));
        yield* Deferred.succeed(resumeReadiness, undefined);
        expect((yield* Fiber.join(opening)).isError).toBe(true);
        expect(bootCalls).toBe(0);
        expect(yield* Ref.get(sessions)).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          McpHttpServer.layerDeviceToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(devices),
            Layer.provide(access),
          ),
        ),
      );
    }),
);
