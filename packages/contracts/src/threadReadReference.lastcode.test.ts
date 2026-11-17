import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadToolInput,
  ThreadReadFailureReason,
  ThreadReadRequest,
  ThreadReadResponse,
} from "./orchestratorMcp.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const exact = {
  threadId: "thread-reference",
  environmentId: "environment-reference",
  via: "reference",
  itemId: "item-reference",
  textOffset: 20,
  view: "activity",
  beforePosition: 42,
  limit: 5,
  runLimit: 2,
  maxCharsPerItem: 100,
} as const;
const envelope = { connectionId: "connection", requestId: "request" };
const decodeTool = Schema.decodeSync(OrchestratorMcpThreadReadToolInput);
const decodeWireUnknown = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeWire = Schema.decodeSync(OrchestratorMcpThreadReadInput);
const encodeWire = Schema.encodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeRequest = Schema.decodeUnknownSync(ThreadReadRequest);
const localReadRpc = WsRpcGroup.requests.get(WS_METHODS.threadReadLocal)!;
const decodeRpc = Schema.decodeSync(localReadRpc.payloadSchema);
const decodeResponse = Schema.decodeUnknownSync(ThreadReadResponse);
const decodeFailure = Schema.decodeUnknownSync(OrchestratorMcpFailure);

describe("tool-only reference read contracts", () => {
  it("accepts reference only at the tool boundary, keeping broker, RPC and peer inputs strict", () => {
    expect(decodeTool(exact)).toEqual(exact);
    expect(() => decodeWireUnknown(exact)).toThrow();
    expect(() => encodeWire(exact)).toThrow();
    expect(() => decodeRequest({ ...envelope, input: exact })).toThrow();
    expect(() => decodeRpc(exact)).toThrow();
    for (const via of ["client", undefined] as const) {
      const input = { ...exact, via };
      expect(decodeWire(input)).toEqual(input);
    }
  });

  it("accepts positive exact no-attempt proof and rejects denial, discovery and false proof", () => {
    const response = { ...envelope, result: null, unavailableEnvironmentIds: [] };
    for (const reason of ["unavailable", "unsupported"]) {
      const failure = { environmentId: "environment-reference", reason };
      expect(decodeResponse({ ...response, failure, noDestinationAttempt: true })).toMatchObject({
        failure,
        noDestinationAttempt: true,
      });
      expect(decodeResponse({ ...response, failure })).not.toHaveProperty("noDestinationAttempt");
    }
    for (const invalid of [
      { ...response, noDestinationAttempt: true },
      {
        ...response,
        failure: { environmentId: "environment-reference", reason: "permission_denied" },
        noDestinationAttempt: true,
      },
      {
        ...response,
        failure: { environmentId: "environment-reference", reason: "unavailable" },
        noDestinationAttempt: false,
      },
      { ...response, result: {}, noDestinationAttempt: true },
    ]) {
      expect(() => decodeResponse(invalid)).toThrow();
    }
    expect(ThreadReadFailureReason.literals).toEqual([
      "permission_denied",
      "unsupported",
      "unavailable",
    ]);
  });

  it("preserves additive server diagnostics without admitting false proof", () => {
    const failure = {
      _tag: "OrchestratorMcpFailure",
      code: "environment_unavailable",
      threadReadReason: "unavailable",
      message: "No initiating client attempted the destination.",
    };
    expect(decodeFailure({ ...failure, noDestinationAttempt: true }).noDestinationAttempt).toBe(
      true,
    );
    expect(decodeFailure(failure)).not.toHaveProperty("noDestinationAttempt");
    expect(() => decodeFailure({ ...failure, noDestinationAttempt: false })).toThrow();
  });
});
