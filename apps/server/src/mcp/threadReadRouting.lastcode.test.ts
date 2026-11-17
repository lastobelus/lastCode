import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  type PeerLink,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ActionResume from "../actionResume/ActionResume.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadReadBroker from "./ThreadReadBroker.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { referenceReadFailure } from "./ThreadReadDiagnostics.ts";

const here = EnvironmentId.make("environment-a");
const there = EnvironmentId.make("environment-b");
const sourceId = ThreadId.make("source-thread");
const targetId = ThreadId.make("target-thread");
const targetProject = ProjectId.make("project-other");
const exact = {
  environmentId: there,
  threadId: targetId,
  via: "reference" as const,
  itemId: "selected-item",
  textOffset: 20,
  view: "activity",
  beforePosition: 42,
  limit: 5,
  runLimit: 2,
  maxCharsPerItem: 100,
} as const;
const input = Schema.decodeSync(OrchestratorToolkit.tools.t3_thread_read.parametersSchema)(exact);

const remoteResult = Schema.decodeSync(OrchestratorMcpThreadReadResult)({
  thread: {
    threadId: targetId,
    environmentId: there,
    link: "[Target](t3-thread://v1/environment-b/target-thread)",
    projectId: targetProject,
    title: "Target",
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: "codex",
    model: "test-model",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 0,
    itemCount: 0,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: null,
  hasMore: false,
});

const harness = Effect.fn(function* (
  options: {
    readonly source?: OrchestrationV2ThreadShell;
    readonly target?: OrchestrationV2ThreadShell;
    readonly scope?: Partial<McpInvocationScope>;
    readonly reference?: Effect.Effect<
      OrchestratorMcpThreadReadResult | OrchestratorMcpFailure,
      OrchestratorMcpFailure
    >;
    readonly peer?: Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    readonly link?: "missing" | "expired" | "unexpected";
    readonly access?: PeerLink["access"];
  } = {},
) {
  const source = options.source ?? liveThreadShell(sourceId);
  const target = options.target ?? { ...liveThreadShell(targetId), projectId: targetProject };
  const calls: Array<{ route: string; input?: OrchestratorMcpThreadReadInput }> = [];
  const scope: McpInvocationScope = {
    environmentId: here,
    requestNamespace: "routing-test",
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    thread: {
      threadId: sourceId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "provider-session",
    },
    client: undefined,
    ...options.scope,
  };
  const shell = (id: ThreadId) => (id === sourceId ? source : id === targetId ? target : null);
  const now = yield* DateTime.now;
  const link: PeerLink = {
    environmentId: there,
    label: "Environment B",
    urls: ["https://environment-b.example"],
    access: options.access ?? "read-only",
    linkedAt: now,
    expiresAt: DateTime.add(now, { days: options.link === "expired" ? -1 : 1 }),
    lastReachedAt: null,
    lastError: null,
  };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ThreadReadBroker.ThreadReadBroker)({
      forSession: () => ({ authorize: () => Effect.undefined }),
      read: (_threadId, _runId, request) => {
        calls.push({ route: "client", input: request });
        return Effect.fail(
          new OrchestratorMcpFailure({ code: "environment_unavailable", message: "No client" }),
        );
      },
      readReference: (_threadId, _runId, request) => {
        expect(_threadId).toBe(sourceId);
        calls.push({ route: "reference", input: request });
        return options.reference ?? Effect.succeed(referenceReadFailure("noGrant", true));
      },
    }),
    Layer.mock(PeerLinks.PeerLinks)({
      get: (environmentId) => {
        expect(environmentId).toBe(there);
        calls.push({ route: "link" });
        if (options.link === "unexpected") return Effect.die("A client must precede link lookup");
        return Effect.succeed(options.link === "missing" ? Option.none() : Option.some(link));
      },
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({
      readThread: (_scope, environmentId, request) => {
        expect(environmentId).toBe(there);
        calls.push({ route: "peer", input: request });
        return options.peer ?? Effect.succeed(remoteResult);
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shell(id)),
      getThreadRecords: (id) => Effect.succeed(idleThreadProjection(shell(id)!)),
      getProjectThreadRecords: ({ threadId }) =>
        Effect.succeed(idleThreadProjection(shell(threadId)!)),
      getTimelinePage: () => {
        calls.push({ route: "local" });
        return Effect.succeed({ items: [], totalItems: 0, hasMore: false, hasEarlier: false });
      },
    }),
    Layer.mock(ActionResume.ActionResume)({ readLatestSummary: () => Effect.succeed(null) }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ServerSettings.ServerSettingsService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  );
  const context = yield* Layer.build(
    OrchestratorMcpService.layer.pipe(Layer.provide(dependencies)),
  );
  const mcp = Context.get(context, OrchestratorMcpService.OrchestratorMcpService);
  return { mcp, scope, calls };
});

describe("reference routing through the real read service", () => {
  it.effect("uses an eligible client before inspecting even a stale peer link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const found = { ...remoteResult, readVia: "client" as const };
        const { mcp, scope, calls } = yield* harness({
          reference: Effect.succeed(found),
          link: "unexpected",
        });
        expect(yield* mcp.readThread(scope, input)).toEqual(found);
        expect(calls).toEqual([{ route: "reference", input: { ...input, via: "client" } }]);
      }),
    ),
  );

  it.effect("selects a valid independent peer only after the broker's no-attempt result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mcp, scope, calls } = yield* harness({ scope: { linkedEnvironments: false } });
        expect(yield* mcp.readThread(scope, input)).toEqual(remoteResult);
        const { via: _via, ...strict } = input;
        expect(calls).toEqual([
          { route: "reference", input: { ...strict, via: "client" } },
          { route: "link" },
          { route: "peer", input: strict },
        ]);
      }),
    ),
  );

  it.effect("ends a selected client or peer failure without switching authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const reason of ["permission_denied", "unsupported", "unavailable"] as const) {
          const failure = new OrchestratorMcpFailure({
            code: reason === "permission_denied" ? "capability_denied" : "environment_unavailable",
            threadReadReason: reason,
            message: "Selected destination failed",
          });
          for (const route of ["reference", "peer"] as const) {
            const { mcp, scope, calls } = yield* harness({ [route]: Effect.fail(failure) });
            expect(yield* mcp.readThread(scope, input).pipe(Effect.flip)).toBe(failure);
            expect(calls.map((call) => call.route)).toEqual(
              route === "reference" ? ["reference"] : ["reference", "link", "peer"],
            );
          }
          const { mcp, scope, calls } = yield* harness({ reference: Effect.succeed(failure) });
          expect(yield* mcp.readThread(scope, input).pipe(Effect.flip)).toBe(failure);
          expect(calls.map((call) => call.route)).toEqual(["reference"]);
        }
      }),
    ),
  );

  it.effect(
    "requires an explicit reference environment and refuses absent or expired peer links",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const link of ["missing", "expired"] as const) {
            const { mcp, scope, calls } = yield* harness({ link });
            expect(
              yield* mcp
                .readThread(scope, { ...input, environmentId: undefined })
                .pipe(Effect.flip),
            ).toMatchObject({ code: "invalid_request" });
            expect(calls).toEqual([]);
            expect(yield* mcp.readThread(scope, input).pipe(Effect.flip)).toMatchObject({
              code: "environment_unavailable",
              threadReadReason: "unavailable",
            });
            expect(calls.map((call) => call.route)).toEqual(["reference", "link"]);
            for (const diagnostic of [
              "disconnected",
              "reauthenticate",
              "noGrant",
              "noDestination",
              "revoked",
              "fence",
            ] as const) {
              const precise = referenceReadFailure(diagnostic, true);
              const recovered = yield* harness({ link, reference: Effect.succeed(precise) });
              const failure = yield* recovered.mcp
                .readThread(recovered.scope, input)
                .pipe(Effect.flip);
              const original = referenceReadFailure(diagnostic);
              expect(failure).toMatchObject({
                code: original.code,
                threadReadReason: original.threadReadReason,
              });
              expect(failure.message).toContain(original.message);
              if (link === "expired") {
                expect(failure.message).toContain(
                  `outgoing read link to ${there} has also expired`,
                );
                expect(failure.message).toContain("renew that link");
                expect(failure.message).not.toContain(
                  "Do not retry this read through another route.",
                );
                expect(failure.message).toContain("do not read again until");
              } else {
                expect(failure.message).toBe(original.message);
              }
              expect(failure.noDestinationAttempt).toBeUndefined();
            }
          }
        }),
      ),
  );

  it.effect("keeps explicit client reads and machine-directed peer reads strict", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mcp, scope, calls } = yield* harness();
        expect(
          yield* mcp.readThread(scope, { ...input, via: "client" }).pipe(Effect.flip),
        ).toMatchObject({ code: "environment_unavailable" });
        expect(calls.map((call) => call.route)).toEqual(["client"]);
        calls.length = 0;
        const { via: _via, ...strict } = input;
        expect(yield* mcp.readThread(scope, strict)).toEqual(remoteResult);
        expect(calls).toEqual([{ route: "peer", input: strict }]);
      }),
    ),
  );

  it.effect("never borrows a client for linked work or outside MCP clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const outside of [false, true, "linked"] as const) {
          const { mcp, scope, calls } = yield* harness(
            outside
              ? {
                  scope: {
                    thread: undefined,
                    client: {
                      sessionId: "outside",
                      label: "Outside",
                      access: "full-access",
                      ...(outside === "linked" ? { linked: true } : {}),
                    },
                  },
                }
              : {
                  source: {
                    ...liveThreadShell(sourceId),
                    linkOrigin: { sessionId: "linked", label: "Linked", access: "full-access" },
                  },
                },
          );
          expect(yield* mcp.readThread(scope, input)).toEqual(remoteResult);
          expect(calls.map((call) => call.route)).toEqual(["link", "peer"]);
          calls.length = 0;
          expect(
            yield* mcp.readThread(scope, { ...input, via: "client" }).pipe(Effect.flip),
          ).toMatchObject({ code: "capability_denied", threadReadReason: "permission_denied" });
          expect(calls).toEqual([]);
        }
      }),
    ),
  );

  it.effect(
    "applies onward link fences before grant or link lookup while keeping local reads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { mcp, scope, calls } = yield* harness({
            source: {
              ...liveThreadShell(sourceId),
              linkOrigin: { sessionId: "linked", label: "Linked", access: "auto" },
            },
            link: "unexpected",
          });
          for (const via of ["reference", "client", undefined] as const) {
            expect(yield* mcp.readThread(scope, { ...input, via }).pipe(Effect.flip)).toMatchObject(
              {
                code: "capability_denied",
              },
            );
            expect(calls).toEqual([]);
            const local = yield* mcp.readThread(scope, { ...input, environmentId: here, via });
            expect(local.thread).toMatchObject({ threadId: targetId, projectId: targetProject });
            expect(calls.map((call) => call.route)).toEqual(["local"]);
            calls.length = 0;
          }
          expect((yield* mcp.readThread(scope, { threadId: targetId })).thread.threadId).toBe(
            targetId,
          );
          calls.length = 0;
          expect(
            yield* mcp
              .readThread(scope, { threadId: ThreadId.make("missing-local-thread") })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "thread_not_found" });
          expect(calls).toEqual([]);
          const outside = yield* harness({
            scope: {
              thread: undefined,
              client: {
                sessionId: "outside-link",
                label: "Outside link",
                linked: true,
                access: "auto",
              },
            },
            link: "unexpected",
          });
          expect(
            yield* outside.mcp.readThread(outside.scope, input).pipe(Effect.flip),
          ).toMatchObject({ code: "capability_denied" });
          expect(outside.calls).toEqual([]);
        }),
      ),
  );

  it.effect("preserves local cross-project reads and checks the caller's capability first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mcp, scope, calls } = yield* harness({
          source: liveThreadShell(sourceId, { runtimeMode: "approval-required" }),
        });
        expect(
          (yield* mcp.readThread(scope, { ...input, environmentId: here })).thread.projectId,
        ).toBe(targetProject);
        expect(calls.map((call) => call.route)).toEqual(["local"]);
        calls.length = 0;
        expect(
          yield* mcp.readThread({ ...scope, capabilities: new Set() }, input).pipe(Effect.flip),
        ).toMatchObject({ code: "capability_denied" });
        expect(calls).toEqual([]);
      }),
    ),
  );
});
