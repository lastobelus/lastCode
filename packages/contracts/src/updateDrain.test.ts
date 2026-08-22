import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UpdateDrainCommand, UpdateDrainCommandReceipt, UpdateDrainState } from "./updateDrain.ts";

const decodeCommand = Schema.decodeUnknownSync(UpdateDrainCommand);
const decodeState = Schema.decodeUnknownSync(UpdateDrainState);
const decodeReceipt = Schema.decodeUnknownSync(UpdateDrainCommandReceipt);

describe("update drain contracts", () => {
  it("decodes start and cancel commands", () => {
    expect(
      decodeCommand({
        type: "update-drain.start",
        commandId: "start-1",
        requestId: "request-1",
        targetVersion: " 1.2.3 ",
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
    ).toMatchObject({ type: "update-drain.start", targetVersion: "1.2.3" });
    expect(
      decodeCommand({
        type: "update-drain.cancel",
        commandId: "cancel-1",
        requestId: "request-1",
        createdAt: "2026-08-21T00:01:00.000Z",
      }),
    ).toMatchObject({ type: "update-drain.cancel" });
  });

  it("keeps blocker and grace data outside the durable status contract", () => {
    const state = decodeState({
      sequence: 1,
      intent: { requestId: "request-1", targetVersion: "1.2.3", status: "draining" },
    });
    const receipt = decodeReceipt({
      commandId: "start-1",
      requestId: "request-1",
      commandType: "update-drain.start",
      targetVersion: "1.2.3",
      acceptedAt: "2026-08-21T00:00:00.000Z",
      resultSequence: 1,
      status: "accepted",
      errorReason: null,
      error: null,
    });

    expect(state).not.toHaveProperty("blockers");
    expect(state).not.toHaveProperty("quietSince");
    expect(receipt.status).toBe("accepted");
  });
});
