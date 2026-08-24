import { MessageId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { resolveTurnRequestWaitState } from "./TurnRequestWaitQuery.ts";

const interruptedRow = {
  correlationState: "started" as const,
  turnId: TurnId.make("turn-interrupt-wait"),
  turnState: "interrupted" as const,
  assistantMessageId: null,
  response: null,
  responseStreaming: null,
  latestFinalizedAssistantResponse: null,
  assistantFinalizedAt: null,
  sessionStatus: "running" as const,
  sessionActiveTurnId: TurnId.make("turn-interrupt-wait"),
};

it("keeps waiting while an interrupt request has not stopped the active provider turn", () => {
  assert.deepEqual(resolveTurnRequestWaitState(interruptedRow), { kind: "pending" });
});

it("settles after the provider session confirms interruption", () => {
  assert.deepEqual(
    resolveTurnRequestWaitState({
      ...interruptedRow,
      sessionStatus: "interrupted",
      sessionActiveTurnId: null,
    }),
    {
      kind: "terminal",
      state: "interrupted",
      turnId: TurnId.make("turn-interrupt-wait"),
    },
  );
});

it("uses a finalized assistant row when a checkpoint placeholder replaced its id", () => {
  assert.deepEqual(
    resolveTurnRequestWaitState({
      ...interruptedRow,
      turnId: TurnId.make("turn-checkpoint-replaced"),
      turnState: "completed",
      assistantMessageId: MessageId.make("assistant:turn-checkpoint-replaced"),
      latestFinalizedAssistantResponse: "actual assistant response",
      assistantFinalizedAt: "2026-08-24T08:00:00.000Z",
      sessionStatus: "ready",
      sessionActiveTurnId: null,
    }),
    {
      kind: "terminal",
      state: "completed",
      turnId: TurnId.make("turn-checkpoint-replaced"),
      response: "actual assistant response",
    },
  );
});

it("keeps a finalized message-free checkpoint response empty", () => {
  assert.deepEqual(
    resolveTurnRequestWaitState({
      ...interruptedRow,
      turnId: TurnId.make("turn-checkpoint-empty"),
      turnState: "completed",
      assistantMessageId: MessageId.make("assistant:turn-checkpoint-empty"),
      assistantFinalizedAt: "2026-08-24T08:00:00.000Z",
      sessionStatus: "ready",
      sessionActiveTurnId: null,
    }),
    {
      kind: "terminal",
      state: "completed",
      turnId: TurnId.make("turn-checkpoint-empty"),
      response: "",
    },
  );
});
