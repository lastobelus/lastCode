import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestConsole from "effect/testing/TestConsole";
import { vi } from "vite-plus/test";

import { threadCommand } from "../cli/thread.ts";
import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

import { ActionResumeToolkit } from "../mcp/toolkits/actionResume/tools.ts";
import { preferences } from "../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { unknownCapacitySnapshot } from "./logic.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  const { AuthSessionId } = await import("@t3tools/contracts");
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt: DateTime.makeUnsafe(1),
        }),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const isSettingsPatch = Schema.is(ServerSettingsPatch);
const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);
const decodeLaunch = Schema.decodeSync(ProjectToolkit.tools.t3_thread_launch.successSchema);
const decodeEnvironment = Schema.decodeSync(
  EnvironmentToolkit.tools.t3_environment_read.successSchema,
);
const decodeDelegation = Schema.decodeSync(OrchestratorToolkit.tools.delegate_task.successSchema);
const decodeCreated = Schema.decodeSync(OrchestratorToolkit.tools.create_threads.successSchema);
const decodeAction = Schema.decodeSync(
  ActionResumeToolkit.tools.run_project_action_and_resume.successSchema,
);

it("decodes a server config with a newer capacity mode", () => {
  const config = decodeServerConfig({
    environment: {
      environmentId: "environment-example",
      label: "Newer environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0",
      capabilities: {},
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test-cookie",
    },
    cwd: "/example",
    keybindingsConfigPath: "/example/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/example/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: { capacityMode: "enforce", responseStreamingMode: "turn" },
  });
  expect(config.cwd).toBe("/example");
  expect(config.settings).toMatchObject({ capacityMode: "enforce", responseStreamingMode: "turn" });
  expect(preferences(config.settings).capacityMode).toBe("enforce");
});

it("only accepts known capacity modes in settings and environment preferences updates", () => {
  const isPreferencesUpdate = Schema.is(
    EnvironmentToolkit.tools.t3_environment_preferences_update.parametersSchema,
  );
  for (const mode of ["off", "observe", "enforce"]) {
    expect(isSettingsPatch({ capacityMode: mode })).toBe(mode !== "enforce");
    expect(isPreferencesUpdate({ capacityMode: mode })).toBe(mode !== "enforce");
  }
});

it("accepts launch and environment responses from servers without capacity support", () => {
  const launch = decodeLaunch({
    threadId: "thread-example",
    projectId: "project-example",
    modelSelection: { instanceId: "codex", model: "example" },
    runId: null,
    status: null,
  });
  expect(launch.capacity).toBeUndefined();
  const { capacityMode: _capacityMode, ...olderPreferences } = preferences(DEFAULT_SERVER_SETTINGS);
  const environment = decodeEnvironment({
    environmentId: "environment-example",
    label: "Older environment",
    serverVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    preferences: olderPreferences,
  });
  expect(environment.capacity).toBeUndefined();
});

it("accepts delegation, thread creation and Action results without a capacity block", () => {
  const delegation = decodeDelegation({
    taskId: "task-example",
    childThreadId: "child-example",
    childRunId: null,
    childNodeId: "node-example",
    status: "starting",
    workState: "working",
    hasPendingChildRuns: false,
    latestTerminalRunId: null,
    latestTerminalStatus: null,
    latestTerminalSummary: null,
    latestTerminalResultContextTransferId: null,
    providerInstanceId: "codex",
    model: null,
    summary: null,
    resultContextTransferId: null,
    hasPendingQuestion: false,
    pendingApproval: null,
    waitTimedOut: false,
  });
  expect(delegation.capacity).toBeUndefined();
  const created = decodeCreated({
    threads: [],
  });
  expect(created.capacity).toBeUndefined();
  const action = decodeAction({
    runId: "run-example",
    threadId: "thread-example",
    projectId: "project-example",
    actionId: "action-example",
    actionName: "Example Action",
    terminalId: "terminal-example",
    outcome: "running",
    delivery: "armed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    exitSignal: null,
  });
  expect(action.capacity).toBeUndefined();
});

const snapshot = unknownCapacitySnapshot(10);
const futureCapacity = {
  ...snapshot,
  mode: "enforce",
  measurements: {
    sampledAt: 10,
    physicalCores: 4,
    load1: 0.2,
    load5: 0.1,
    memoryPressure: "elevated",
    swapUsedBytes: 0,
    worktreesFreeBytes: null,
    worktreeFoldersByProject: null,
  },
  verdicts: {
    ...snapshot.verdicts,
    agent: {
      state: "throttle",
      reasons: [{ signal: "cpuTemperature", comparison: "gt", value: 95, limit: 90 }],
    },
  },
};
const futureEnvironmentCapacity = {
  ...futureCapacity,
  linkedObservation: "not-requested",
  linked: [],
};
const target = EnvironmentId.make("remote-example");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("local-example"),
  requestNamespace: "capacity-test",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { sessionId: "test", label: "Test", access: "full-access" },
};
const launchResult = {
  threadId: "thread-example",
  projectId: "project-example",
  modelSelection: { instanceId: "codex", model: "example" },
  runId: null,
  status: null,
};
const environmentResult = {
  environmentId: target,
  label: "Remote example",
  serverVersion: "0.0.0",
  platform: { os: "linux", arch: "x64" },
  preferences: { ...preferences(DEFAULT_SERVER_SETTINGS), capacityMode: "enforce" },
};

const forwardingWith = (structuredContent: unknown) =>
  PeerForwarding.layer.pipe(
    Layer.provide(PeerMcpClient.layer),
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(true),
          resolve: () =>
            Effect.succeed({
              link: {
                environmentId: target,
                label: "Remote example",
                urls: ["https://peer.example"],
                access: "auto",
                linkedAt: DateTime.makeUnsafe(0),
                expiresAt: DateTime.makeUnsafe(1),
                lastReachedAt: null,
                lastError: null,
              },
              url: "https://peer.example",
              token: "fixture",
            }),
          recordOutcome: () => Effect.void,
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    result: {
                      structuredContent,
                      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
                    },
                  }),
                  { headers: { "mcp-session-id": "fixture-session" } },
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

it.effect("keeps a forwarded launch result with newer or malformed capacity", () =>
  Effect.gen(function* () {
    const launch = PeerForwarding.PeerForwarding.pipe(
      Effect.flatMap((forwarding) =>
        forwarding.call(scope, ProjectToolkit.tools.t3_thread_launch, target, { title: "Example" }),
      ),
    );
    const newer = { ...launchResult, capacity: futureCapacity };
    expect(yield* launch.pipe(Effect.provide(forwardingWith(newer)))).toEqual(newer);
    const malformed = { ...launchResult, capacity: { mode: "enforce" } };
    expect(yield* launch.pipe(Effect.provide(forwardingWith(malformed)))).toEqual(launchResult);
  }),
);

const linkedGood = { environmentId: "linked-good", label: "Good", capacity: futureCapacity };
const linkedBad = { environmentId: "linked-bad", label: "Bad" };
const futureLinkedCapacity = {
  ...futureEnvironmentCapacity,
  linkedObservation: "partial",
  linked: [
    linkedGood,
    { ...linkedBad, capacity: { mode: "enforce" } },
    { label: "No environment", capacity: futureCapacity },
  ],
};

it.effect("keeps a forwarded environment read with newer capacity and preferences", () =>
  Effect.gen(function* () {
    const forwarding = yield* PeerForwarding.PeerForwarding;
    expect(
      yield* forwarding.call(scope, EnvironmentToolkit.tools.t3_environment_read, target, {}),
    ).toEqual({
      ...environmentResult,
      capacity: { ...futureLinkedCapacity, linked: [linkedGood] },
    });
  }).pipe(Effect.provide(forwardingWith({ ...environmentResult, capacity: futureLinkedCapacity }))),
);

it.effect("prints thread launch and capacity CLI results from a newer server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-capacity-" });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool) => {
          switch (tool) {
            case "t3_project_list":
              return Effect.succeed({
                structuredContent: {
                  projects: [
                    { id: launchResult.projectId, title: "Example", workspaceRoot: baseDir },
                  ],
                  nextCursor: null,
                },
              });
            case "t3_thread_launch":
              return Effect.succeed({
                structuredContent: { ...launchResult, capacity: futureCapacity },
              });
            case "t3_environment_read":
              return Effect.succeed({
                structuredContent: { ...environmentResult, capacity: futureEnvironmentCapacity },
              });
            default:
              return Effect.die(`unexpected ${tool} call`);
          }
        },
      }),
    );
    const run = Command.runWith(threadCommand, { version: "0.0.0" });
    yield* run(["start", launchResult.projectId, "Example", "--json", "--base-dir", baseDir]);
    expect(JSON.parse(String((yield* TestConsole.logLines).at(-1)))).toEqual({
      threadId: launchResult.threadId,
      projectId: launchResult.projectId,
      runId: launchResult.runId,
      capacity: futureCapacity,
    });
    yield* run(["capacity", "--environment", target, "--base-dir", baseDir]);
    expect(JSON.parse(String((yield* TestConsole.logLines).at(-1)))).toEqual({
      environmentId: target,
      capacity: futureEnvironmentCapacity,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);
