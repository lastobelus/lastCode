import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "@t3tools/provider-cursor/testing";
import { makeGrokAcpAdapterFlavor } from "@t3tools/provider-grok/testing";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as Schema from "effect/Schema";
import * as CommandPolicy from "./CommandPolicy.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const grokCapabilities = makeGrokAcpAdapterFlavor(
  {
    instanceId: ProviderInstanceId.make("grok"),
    settings: decodeGrokSettings({}),
    environment: {},
    hostPlatform: "linux",
    selfInvocation: { command: "node", entrypoint: undefined },
  },
  "/example/home",
).capabilities;

const commandId = CommandId.make("command-policy-test");
const threadId = ThreadId.make("command-policy-thread");
const activeRunId = RunId.make("command-policy-active-run");
const activeAttemptId = RunAttemptId.make("command-policy-active-attempt");
const userMessageId = MessageId.make("command-policy-user-message");

const baseCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;

function capabilities(
  override: (current: OrchestrationV2ProviderCapabilities) => OrchestrationV2ProviderCapabilities,
): OrchestrationV2ProviderCapabilities {
  return override(baseCapabilities);
}

function dispatchProjection(
  sessionCapabilities?: OrchestrationV2ProviderCapabilities,
): OrchestrationV2ThreadProjection {
  const providerThreadId = ProviderThreadId.make("command-policy-provider-thread");
  const providerSessionId = ProviderSessionId.make("command-policy-provider-session");
  return {
    thread: {},
    runs:
      sessionCapabilities === undefined
        ? []
        : [
            {
              id: activeRunId,
              status: "running",
              providerThreadId,
              activeAttemptId,
              userMessageId,
            },
          ],
    messages: [{ id: userMessageId, text: "first", attachments: [] }],
    providerThreads:
      sessionCapabilities === undefined ? [] : [{ id: providerThreadId, providerSessionId }],
    providerSessions:
      sessionCapabilities === undefined
        ? []
        : [{ id: providerSessionId, capabilities: sessionCapabilities }],
    providerTurns:
      sessionCapabilities === undefined
        ? []
        : [{ runAttemptId: activeAttemptId, status: "running" }],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("resolves automatic message delivery from authoritative provider capabilities", () => {
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "start_immediately" },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(baseCapabilities),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "steer_active", targetRunId: activeRunId },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(
        capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsQueuedMessages: true,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      ),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "queue_after_active" },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      dispatchProjection(
        capabilities((current) => ({
          ...current,
          turns: {
            ...current.turns,
            supportsActiveSteering: false,
            supportsQueuedMessages: false,
            supportsSteeringByInterruptRestart: true,
          },
        })),
      ),
      { type: "start_immediately" },
      "auto",
    ),
    { type: "restart_active", targetRunId: activeRunId },
  );
});

it.each(["preparing", "starting"] as const)(
  "queues an automatic message while the handoff run is %s",
  (status) => {
    const projection = dispatchProjection(baseCapabilities);
    assert.deepEqual(
      CommandPolicy.resolveMessageDispatchIntent(
        { ...projection, runs: projection.runs.map((run) => ({ ...run, status })) },
        { type: "start_immediately" },
        "auto",
      ),
      { type: "queue_after_active" },
    );
  },
);

it.each([
  ["has not started", []],
  ["is pending", [{ runAttemptId: activeAttemptId, status: "pending" }]],
  ["has completed", [{ runAttemptId: activeAttemptId, status: "completed" }]],
  [
    "belongs to a previous attempt",
    [{ runAttemptId: RunAttemptId.make("previous-attempt"), status: "running" }],
  ],
])("queues only automatic delivery when the active run's provider turn %s", (_, providerTurns) => {
  const projection = {
    ...dispatchProjection(baseCapabilities),
    providerTurns,
  } as unknown as OrchestrationV2ThreadProjection;
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(projection, { type: "start_immediately" }, "auto"),
    { type: "queue_after_active" },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(projection, { type: "start_immediately" }, "steer"),
    { type: "steer_active", targetRunId: activeRunId },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      projection,
      { type: "start_immediately" },
      "restart",
    ),
    { type: "restart_active", targetRunId: activeRunId },
  );
});

it.each(["/compact", " /LOGOUT "])("queues a steer sent while %s runs", (text) => {
  const projection = dispatchProjection(baseCapabilities);
  const maintenance = {
    ...projection,
    messages: [{ id: userMessageId, text, attachments: [] }],
  } as unknown as OrchestrationV2ThreadProjection;
  for (const deliveryIntent of ["auto", "steer"] as const) {
    assert.deepEqual(
      CommandPolicy.resolveMessageDispatchIntent(
        maintenance,
        { type: "start_immediately" },
        deliveryIntent,
      ),
      { type: "queue_after_active" },
    );
  }
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(maintenance, {
      type: "steer_active",
      targetRunId: activeRunId,
    }),
    { type: "queue_after_active" },
  );
  assert.deepEqual(
    CommandPolicy.resolveMessageDispatchIntent(
      maintenance,
      { type: "start_immediately" },
      "restart",
    ),
    { type: "restart_active", targetRunId: activeRunId },
  );
});

it.each(["suspect", "stale", "recovering", "failed"] as const)(
  "queues auto and steer deliveries while the matching attempt is %s",
  (status) => {
    const projection = dispatchProjection(baseCapabilities);
    const attemptId = RunAttemptId.make("recovery-attempt");
    const recovering = {
      ...projection,
      thread: {
        ...projection.thread,
        recovery: {
          runId: activeRunId,
          attemptId,
          status,
          detail: "Event reader failed",
          updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        },
      },
      runs: projection.runs.map((run) => ({ ...run, activeAttemptId: attemptId })),
      providerTurns: projection.providerTurns.map((turn) => ({ ...turn, runAttemptId: attemptId })),
    };
    for (const intent of ["auto", "steer", undefined] as const) {
      assert.deepEqual(
        CommandPolicy.resolveMessageDispatchIntent(
          recovering,
          { type: "steer_active", targetRunId: activeRunId },
          intent,
        ),
        { type: "queue_after_active" },
      );
    }
    assert.deepEqual(
      CommandPolicy.resolveMessageDispatchIntent(
        recovering,
        { type: "start_immediately" },
        "restart",
      ),
      { type: "restart_active", targetRunId: activeRunId },
    );
    for (const recovery of [
      { ...recovering.thread.recovery, status: "recovered" as const },
      { ...recovering.thread.recovery, attemptId: RunAttemptId.make("old-attempt") },
      { ...recovering.thread.recovery, runId: RunId.make("old-run") },
    ]) {
      assert.deepEqual(
        CommandPolicy.resolveMessageDispatchIntent(
          {
            ...recovering,
            thread: { ...recovering.thread, recovery },
          },
          { type: "start_immediately" },
          "auto",
        ),
        { type: "steer_active", targetRunId: activeRunId },
      );
      assert.deepEqual(
        CommandPolicy.resolveMessageDispatchIntent(
          {
            ...recovering,
            thread: { ...recovering.thread, recovery },
            providerTurns: projection.providerTurns,
          },
          { type: "start_immediately" },
          "auto",
        ),
        { type: "queue_after_active" },
      );
    }
  },
);

const layer = it.layer(CommandPolicy.layer);

layer("CommandPolicyV2", (it) => {
  it.effect("native-only steering never falls back to interruption", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;
      const input = {
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        nativeOnly: true,
      };
      assert.equal(
        yield* policy.decideSteeringExecution({ ...input, capabilities: baseCapabilities }),
        "active_steering",
      );
      for (const unsafe of [
        { forceRestart: true, capabilities: baseCapabilities },
        ...[
          AcpProviderCapabilitiesV2,
          ClaudeProviderCapabilitiesV2,
          CursorProviderCapabilitiesV2,
          grokCapabilities,
        ].map((providerCapabilities) => ({ capabilities: providerCapabilities })),
        ...[false, undefined].map((supportsStrictActiveSteering) => ({
          capabilities: capabilities((current) => ({
            ...current,
            turns: { ...current.turns, supportsStrictActiveSteering },
          })),
        })),
        {
          capabilities: capabilities((current) => ({
            ...current,
            turns: { ...current.turns, supportsActiveSteering: false },
          })),
        },
        {
          capabilities: capabilities((current) => ({
            ...current,
            turns: { ...current.turns, activeSteeringInterruptsTools: true },
          })),
        },
      ]) {
        const error = yield* policy
          .decideSteeringExecution({ ...input, ...unsafe })
          .pipe(Effect.flip);
        assert.instanceOf(error, CommandPolicy.CommandPolicyCapabilityUnsupportedError);
      }
    }),
  );
  it.effect("falls back to portable context when Cursor cannot fork natively", () =>
    Effect.gen(function* () {
      const policy = yield* CommandPolicy.CommandPolicyV2;

      const result = yield* policy.decideForkExecution({
        commandId,
        threadId,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        capabilities: CursorProviderCapabilitiesV2,
        sameProvider: true,
        hasStrongNativeSource: true,
        sourceRunStatus: "completed",
        fromSpecificTurn: true,
      });

      assert.equal(result, "portable_context");
    }),
  );
});
