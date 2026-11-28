import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";

import * as Claude from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Codex from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { readReplayFixtureTranscript } from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const services = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "<workspace>",
});
const threadId = ThreadId.make("thread-wrapped-command");
const codexSettings = Schema.decodeSync(CodexSettings)({});
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});

const observation = Effect.gen(function* () {
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const requests: ProviderContinuationRequest[] = [];
  const changes = yield* PubSub.unbounded<void>();
  return {
    events,
    requests,
    roster: () => events.findLast((event) => event.type === "provider_thread.updated"),
    watch: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
      runtime.events.pipe(
        Stream.runForEach((event) =>
          event.type === "events.barrier"
            ? event.after
            : Effect.sync(() => events.push(event)).pipe(
                Effect.andThen(PubSub.publish(changes, undefined)),
              ),
        ),
        Effect.forkScoped,
      ),
    offer: (request: ProviderContinuationRequest) =>
      Effect.sync(() => requests.push(request)).pipe(
        Effect.andThen(PubSub.publish(changes, undefined)),
        Effect.asVoid,
      ),
    until: (predicate: () => boolean) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          while (!predicate()) yield* PubSub.take(subscription);
        }),
      ),
  };
});

const startTurn = Effect.fnUntraced(function* (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  modelSelection: ModelSelection,
  title: string,
  text: string,
) {
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-wrapped-command"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turn: ProviderAdapter.ProviderAdapterV2TurnInput = {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project-wrapped-command"),
      title,
      providerInstanceId: adapter.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make("run-wrapped-command"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-wrapped-command"),
    rootNodeId: NodeId.make("node-wrapped-command"),
    providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message-wrapped-command"),
      text,
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  };
  yield* runtime.startTurn(turn);
  return { runtime, turn };
});

const codexCommand = "/bin/zsh -lc 'cd /workspace && ./scripts/lc-run prepare'";
const failingChain = "ls missing-file && ./scripts/lc-run prepare";
const failingPrefixOutput = "ls: missing-file: No such file or directory";
const codexTaskId = "call-wrapped-codex";
const codexProcessId = "4242";

type CodexCommandCompletion = "after-turn" | "marked" | "yielded" | "foreground" | "interrupted";
type CodexCommandRetirement = "archive" | "stop" | "unload";

const codexTranscript = Effect.fnUntraced(function* (
  completion: CodexCommandCompletion,
  retire: CodexCommandRetirement | undefined,
) {
  const recorded = yield* readReplayFixtureTranscript(
    new URL("../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson", import.meta.url),
  ).pipe(Effect.flatMap(CodexOrchestratorReplayHarness.decodeTranscript));
  const terminalIndex = recorded.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed",
  );
  const terminal = recorded.entries[terminalIndex];
  if (
    terminal?.type !== "emit_inbound" ||
    !Predicate.isObject(terminal.frame) ||
    !Predicate.isObject(terminal.frame.params) ||
    !Predicate.isObject(terminal.frame.params.turn)
  ) {
    return yield* Effect.die("The Codex replay fixture must include a completed turn.");
  }
  const nativeThreadId = terminal.frame.params.threadId;
  const nativeTurnId = terminal.frame.params.turn.id;
  const command = completion === "yielded" ? failingChain : codexCommand;
  const output = completion === "yielded" ? failingPrefixOutput : "Wrapped command finished";
  const commandFrame = (completed: boolean): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: completed ? "wrapped command completed" : "wrapped command started",
    frame: {
      method: completed ? "item/completed" : "item/started",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        item: {
          type: "commandExecution",
          id: codexTaskId,
          command,
          cwd: "/workspace",
          processId: codexProcessId,
          source: "unifiedExecStartup",
          status: completed ? "completed" : "inProgress",
          commandActions: [{ type: "unknown", command }],
          aggregatedOutput: completed ? output : null,
          exitCode: completed ? (completion === "yielded" ? 1 : 3) : null,
          durationMs: null,
        },
      },
    },
  });
  const launched = [...recorded.entries.slice(0, terminalIndex), commandFrame(false)];
  if (completion === "yielded") {
    const usage = recorded.entries.find(
      (entry) => entry.type === "emit_inbound" && entry.label === "thread/tokenUsage/updated",
    );
    if (usage === undefined) return yield* Effect.die("The fixture must include token usage.");
    launched.push(usage);
  }
  const turnEnd =
    completion === "interrupted"
      ? {
          ...terminal,
          frame: {
            ...terminal.frame,
            params: {
              ...terminal.frame.params,
              turn: { ...terminal.frame.params.turn, status: "interrupted" },
            },
          },
        }
      : terminal;
  return {
    ...recorded,
    entries: [
      ...launched,
      ...(completion === "after-turn"
        ? [turnEnd, commandFrame(true)]
        : [commandFrame(true), commandFrame(true), turnEnd]),
      ...(retire === "archive" || retire === "unload"
        ? [
            {
              type: "expect_outbound" as const,
              label: retire,
              frame: {
                id: 7,
                method: retire === "archive" ? "thread/archive" : "thread/unsubscribe",
                params: { threadId: nativeThreadId },
              },
            },
            {
              type: "emit_inbound" as const,
              label: `${retire} response`,
              frame: { id: 7, result: retire === "archive" ? {} : { status: "notLoaded" } },
            },
          ]
        : []),
    ],
  };
});

it.effect.each([
  { enabled: false, release: false, completion: "after-turn" },
  { enabled: true, release: false, completion: "after-turn" },
  { enabled: true, release: true, completion: "after-turn" },
  { enabled: true, release: false, completion: "marked" },
  { enabled: true, release: true, completion: "marked" },
  { enabled: true, release: false, completion: "yielded" },
  { enabled: true, release: false, completion: "foreground" },
  { enabled: true, release: false, completion: "interrupted" },
  { enabled: true, release: false, completion: "marked", retire: "archive" },
  { enabled: true, release: false, completion: "marked", retire: "unload" },
  { enabled: true, release: false, completion: "after-turn", retire: "stop" },
] satisfies ReadonlyArray<{
  enabled: boolean;
  release: boolean;
  completion: CodexCommandCompletion;
  retire?: CodexCommandRetirement;
}>)(
  "hands off a wrapped Codex command result (enabled=$enabled release=$release completion=$completion retire=$retire)",
  ({ enabled, release, completion, retire }) =>
    Effect.gen(function* () {
      const beforeTerminal = completion !== "after-turn";
      const seen = yield* observation;
      const allowCompletion = yield* Deferred.make<void>();
      const replay = yield* CodexReplay.makeReplayDriver(
        yield* codexTranscript(completion, retire),
        {
          beforeEmitInbound: (entry) =>
            entry.label === "wrapped command completed"
              ? Deferred.await(allowCompletion)
              : Effect.void,
        },
      );
      const adapter = yield* Codex.makeCodexAdapterV2({
        instanceId: Codex.CODEX_DEFAULT_INSTANCE_ID,
        settings: codexSettings,
        environment: {},
        clientFactory: {
          open: (input) =>
            Layer.build(CodexReplay.layerReplayWithDriver(replay)).pipe(
              Effect.flatMap((context) =>
                Effect.provide(Effect.service(CodexClient.CodexAppServerClient), context),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: Codex.CODEX_DRIVER_KIND,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        readBackgroundWait: Effect.succeed(enabled),
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig("wrapped-codex"),
        continuationRequests: { offer: seen.offer },
      });
      const { runtime, turn } = yield* startTurn(
        adapter,
        { instanceId: adapter.instanceId, model: "gpt-6-luna" },
        "Replay fixture: simple",
        "Respond with the following text: fixture simple ok",
      );
      yield* seen.watch(runtime);
      yield* seen.until(() =>
        beforeTerminal
          ? seen
              .roster()
              ?.providerThread.pendingBackgroundTasks?.some(
                (task) => task.taskId === codexTaskId && task.awaited === true,
              ) === true
          : seen.events.some((event) => event.type === "turn.terminal"),
      );
      assert.isFalse(
        seen.events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "completed",
        ),
      );
      assert.deepEqual(
        seen.roster()?.providerThread.pendingBackgroundTasks ?? [],
        enabled
          ? [
              {
                taskId: codexTaskId,
                kind: "command",
                description: completion === "yielded" ? failingChain : codexCommand,
                awaited: true,
                runId: turn.runId,
              },
            ]
          : [],
      );

      if (completion === "marked" || completion === "interrupted") {
        assert.deepEqual(
          yield* runtime.awaitBackgroundTasks!({
            providerThread: turn.providerThread,
            taskIds: [codexProcessId],
            awaited: true,
          }),
          { matched: [codexProcessId] },
        );
      }
      yield* Deferred.succeed(allowCompletion, undefined);
      const owed = { taskId: codexTaskId, originRunId: turn.runId };
      yield* seen.until(() => seen.events.some((event) => event.type === "turn.terminal"));
      const terminal = seen.events.find((event) => event.type === "turn.terminal")!;
      assert.equal(terminal.status, completion === "interrupted" ? "interrupted" : "completed");
      const acknowledgment = {
        providerThreadId: terminal.providerThreadId,
        providerTurnId: terminal.providerTurnId,
      };
      if (completion === "foreground" || completion === "interrupted") {
        yield* runtime.acknowledgeTurnTerminal!(acknowledgment);
        assert.deepEqual(seen.roster()?.providerThread.pendingBackgroundTasks, []);
        assert.deepEqual(seen.roster()?.providerThread.owedBackgroundResults, []);
        assert.lengthOf(seen.requests, 0);
        return;
      }
      if (beforeTerminal) {
        assert.deepEqual(seen.roster()?.providerThread.owedBackgroundResults, [owed]);
        assert.lengthOf(seen.requests, 0);
        yield* runtime.acknowledgeTurnTerminal!(acknowledgment);
        yield* runtime.acknowledgeTurnTerminal!(acknowledgment);
      }
      yield* seen.until(() => seen.requests.length === 1);
      const wake = seen.requests[0]!;
      assert.deepEqual(
        wake.backgroundResultContinuation,
        enabled
          ? {
              providerThreadId: turn.providerThread.id,
              originRunId: turn.runId,
              taskIds: [codexTaskId],
            }
          : undefined,
      );
      assert.deepEqual(seen.roster()?.providerThread.pendingBackgroundTasks ?? [], []);
      if (!enabled) return;

      assert.include(
        wake.detail,
        completion === "yielded" ? failingPrefixOutput : "Wrapped command finished",
      );
      assert.include(
        wake.detail,
        `Background command completed (exit ${completion === "yielded" ? 1 : 3})`,
      );
      assert.equal(wake.notification?.outcome, "failed");
      assert.isTrue(seen.roster()?.backgroundRosterOnly);
      assert.deepEqual(seen.roster()?.providerThread.owedBackgroundResults, [owed]);
      if (retire !== undefined) {
        if (retire === "archive" || retire === "unload") {
          yield* runtime.unloadThread!({
            providerThread: turn.providerThread,
            archive: retire === "archive",
          });
        } else {
          yield* runtime.interruptTurn({
            ...acknowledgment,
            providerThread: turn.providerThread,
            requestRuntimeRestart: true,
          });
        }
        assert.isTrue(
          Option.isNone(yield* wake.dispatchIfCurrent!(Effect.void)),
          "a retired result must not dispatch",
        );
        yield* seen.until(() => seen.roster()?.providerThread.owedBackgroundResults?.length === 0);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(turn.providerThread));
        return;
      }
      if (completion === "after-turn" && !release) {
        assert.deepEqual(
          [
            yield* runtime.hasPendingBackgroundWork!,
            yield* runtime.hasPendingBackgroundWorkForThread!(turn.providerThread),
          ],
          [true, true],
          "owed work must keep the shared process and the owning thread alive",
        );
      }
      if (release) {
        assert.deepEqual(
          yield* runtime.awaitBackgroundTasks!({
            providerThread: turn.providerThread,
            taskIds: [codexProcessId],
            awaited: false,
          }),
          { matched: [codexProcessId] },
        );
      }
      const admitted = yield* wake.dispatchIfCurrent!(
        Effect.sync(() =>
          assert.deepEqual(seen.roster()?.providerThread.owedBackgroundResults, [owed]),
        ),
      );
      assert.equal(Option.isSome(admitted), !release);
      assert.lengthOf(seen.requests, 1);
      yield* seen.until(() => seen.roster()?.providerThread.owedBackgroundResults?.length === 0);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(turn.providerThread));
    }).pipe(Effect.scoped, Effect.provide(services)),
);

const claudeSession = "native-wrapped-claude";
const claudeTaskId = "wrapped-claude-task";
const claudeToolUseId = "toolu_wrapped_claude";
const claudeCommand = "CI=1 ./scripts/lc-run ci --quick";
const claudeCompletedNotificationId = "00000000-0000-4000-8000-000000000201";
const sdkFrame = (uuid: string, fields: Record<string, unknown>): SDKMessage =>
  ({ ...fields, uuid, session_id: claudeSession }) as SDKMessage;

const claudeRoster = (description: string) =>
  sdkFrame(description, {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: claudeTaskId, task_type: "local_bash", description }],
  });

it.effect.each([
  { enabled: false, promoted: false },
  { enabled: false, promoted: true },
  { enabled: true, promoted: false },
  { enabled: true, promoted: true },
  { enabled: true, promoted: false, completedBeforeWake: true },
  { enabled: true, promoted: false, configuredTimeout: "10800000" },
])(
  "retains an awaited Claude command after its turn completes (enabled=$enabled promoted=$promoted timeout=$configuredTimeout completedBeforeWake=$completedBeforeWake)",
  ({ enabled, promoted, configuredTimeout, completedBeforeWake }) =>
    Effect.gen(function* () {
      const seen = yield* observation;
      const messages = yield* Queue.unbounded<SDKMessage>();
      const completedNotification = yield* Deferred.make<void>();
      const fileSystem = yield* FileSystem.FileSystem;
      const openedOptions = yield* Deferred.make<Claude.ClaudeAgentSdkQueryOptions>();
      const adapter = yield* Claude.makeClaudeAdapterV2({
        instanceId: Claude.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: claudeSettings,
        environment:
          configuredTimeout === undefined ? {} : { BASH_DEFAULT_TIMEOUT_MS: configuredTimeout },
        attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-wrapped-" }),
        fileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        continuationRequests: { offer: seen.offer },
        queryRunner: {
          allocateSessionId: Effect.succeed(claudeSession),
          open: ({ options }) =>
            Deferred.succeed(openedOptions, options).pipe(
              Effect.as({
                messages: Stream.fromQueue(messages).pipe(
                  Stream.flatMap((message) =>
                    message.uuid === claudeCompletedNotificationId
                      ? Stream.make(message).pipe(
                          Stream.concat(
                            Stream.fromEffect(
                              Deferred.succeed(completedNotification, undefined),
                            ).pipe(Stream.drain),
                          ),
                        )
                      : Stream.make(message),
                  ),
                ),
                offer: () => Effect.void,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                renameSession: () => Effect.void,
                stopTask: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                mcpServerStatus: Effect.succeed([]),
                readMcpResource: () => Effect.die("unexpected MCP resource read"),
                mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                callMcpTool: () => Effect.die("unexpected MCP tool call"),
                listPermissionRules: Effect.die("unexpected permission rules read"),
                interrupt: Effect.void,
                close: Effect.void,
              }),
            ),
          forkSession: () => Effect.die("unexpected session fork"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      }).pipe(
        Effect.provide(ServerSettingsService.layerTest({ lastcodeBackgroundWaitEnabled: enabled })),
      );
      const { runtime, turn } = yield* startTurn(
        adapter,
        { instanceId: adapter.instanceId, model: "claude-sonnet-4-6" },
        "Wrapped command",
        "Run the wrapper.",
      );
      yield* seen.watch(runtime);
      const options = yield* Deferred.await(openedOptions);
      const env = typeof options.settings === "object" ? options.settings.env : undefined;
      assert.equal(
        env?.BASH_DEFAULT_TIMEOUT_MS,
        enabled && configuredTimeout === undefined ? "7200000" : undefined,
      );
      assert.equal(options.env?.BASH_DEFAULT_TIMEOUT_MS, configuredTimeout);
      assert.equal(env?.LASTCODE_BACKGROUND_WAIT, enabled ? "1" : undefined);
      yield* Queue.offerAll(messages, [
        sdkFrame("wrapped-bash", {
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: "wrapped-bash",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: claudeToolUseId,
                name: "Bash",
                input: {
                  command: claudeCommand,
                  description: "Run CI",
                  run_in_background: !promoted,
                },
              },
            ],
          },
          parent_tool_use_id: null,
        }),
        sdkFrame("wrapped-started", {
          type: "system",
          subtype: "task_started",
          task_id: claudeTaskId,
          tool_use_id: claudeToolUseId,
          description: "Run CI",
          is_backgrounded: !promoted,
          task_type: "local_bash",
        }),
        ...(promoted ? [claudeRoster("Run CI")] : []),
        sdkFrame("wrapped-turn-result", {
          type: "result",
          subtype: "success",
          duration_ms: 10,
          duration_api_ms: 10,
          is_error: false,
          num_turns: 1,
          result: "Started the wrapper.",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          terminal_reason: "completed",
        }),
      ]);
      yield* seen.until(() => seen.events.some((event) => event.type === "turn.terminal"));
      const pending = () =>
        seen
          .roster()
          ?.providerThread.pendingBackgroundTasks?.find((task) => task.taskId === claudeTaskId);
      assert.equal(pending()?.command, claudeCommand);
      assert.equal(pending()?.awaited, enabled ? true : undefined);
      assert.deepEqual(
        seen.roster()?.providerThread.owedBackgroundResults,
        enabled ? [{ taskId: claudeTaskId, originRunId: turn.runId }] : [],
      );
      if (!enabled) return;

      if (completedBeforeWake) {
        yield* Queue.offer(
          messages,
          sdkFrame(claudeCompletedNotificationId, {
            type: "system",
            subtype: "task_notification",
            task_id: claudeTaskId,
            tool_use_id: claudeToolUseId,
            status: "completed",
            summary: "CI finished.",
            output_file: "/workspace/ci.log",
          }),
        );
        yield* Deferred.await(completedNotification);
        assert.deepEqual(
          [
            yield* runtime.hasPendingBackgroundWork!,
            yield* runtime.hasPendingBackgroundWorkForThread!(turn.providerThread),
          ],
          [true, true],
        );
        assert.lengthOf(seen.requests, 0);
        assert.deepEqual(
          yield* runtime.awaitBackgroundTasks!({
            providerThread: turn.providerThread,
            taskIds: [claudeTaskId],
            awaited: false,
          }),
          { matched: [claudeTaskId] },
        );
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(turn.providerThread));
        return;
      }

      assert.deepEqual(
        yield* runtime.awaitBackgroundTasks!({
          providerThread: turn.providerThread,
          taskIds: [claudeTaskId],
          awaited: false,
        }),
        { matched: [claudeTaskId] },
      );
      yield* Queue.offer(messages, claudeRoster("Run CI is still running"));
      yield* seen.until(() => pending()?.description === "Run CI is still running");
      assert.isUndefined(pending()?.awaited);
      assert.deepEqual(seen.roster()?.providerThread.owedBackgroundResults, []);
    }).pipe(Effect.scoped, Effect.provide(services)),
);
