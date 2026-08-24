import { TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { resolveTurnRequestWaitState } from "./TurnRequestWaitQuery.ts";

const interruptedRow = {
  correlationState: "started" as const,
  turnId: TurnId.make("turn-interrupt-wait"),
  turnState: "interrupted" as const,
  assistantMessageId: null,
  response: null,
  responseStreaming: null,
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
