import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  UpdateActivationCommitInput,
  UpdateDrainCommand,
  UpdateDrainCommandReceipt,
  UpdateDrainState,
  UpdateDrainStatus,
} from "./updateDrain.ts";

const decodeCommand = Schema.decodeUnknownSync(UpdateDrainCommand);
const decodeState = Schema.decodeUnknownSync(UpdateDrainState);
const decodeReceipt = Schema.decodeUnknownSync(UpdateDrainCommandReceipt);
const decodeStatus = Schema.decodeUnknownSync(UpdateDrainStatus);
const decodeActivationCommit = Schema.decodeUnknownSync(UpdateActivationCommitInput);

describe("update drain contracts", () => {
  it("decodes lifecycle commands", () => {
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
    expect(
      decodeCommand({
        type: "update-drain.claim",
        commandId: "update-drain:claim:request-1",
        requestId: "request-1",
        createdAt: "2026-08-21T00:02:00.000Z",
      }),
    ).toMatchObject({ type: "update-drain.claim" });
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

  it("decodes the minimal live blocker status separately from durable state", () => {
    const status = decodeStatus({
      sequence: 2,
      intent: { requestId: "request-1", targetVersion: "1.2.3", status: "claimed" },
      admission: "closed",
      blockers: [
        {
          type: "terminal-process",
          threadId: "thread-1",
          terminalId: "terminal-1",
          label: "tests",
          status: "running",
        },
      ],
    });
    expect(status.blockers).toHaveLength(1);
    expect(status).not.toHaveProperty("quietGrace");
  });

  it("accepts only an exact lower-case SHA-256 activation digest", () => {
    expect(
      decodeActivationCommit({ requestId: "request-1", targetDigest: "a".repeat(64) }),
    ).toEqual({ requestId: "request-1", targetDigest: "a".repeat(64) });
    expect(() =>
      decodeActivationCommit({ requestId: "request-1", targetDigest: "A".repeat(64) }),
    ).toThrow();
  });
});
