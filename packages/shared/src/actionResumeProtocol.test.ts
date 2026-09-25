import { describe, expect, it } from "vite-plus/test";

import {
  ACTION_EVENT_TOKEN_ENV,
  ACTION_RUN_ID_ENV,
  actionProtocolFrame,
  createActionProtocolDecoder,
  createActionReporter,
} from "./actionResumeProtocol.ts";

const runId = "run-1";
const token = "token-1";

describe("Action resume protocol", () => {
  it("round-trips framed events split across terminal chunks without leaking the frame", () => {
    const frame = actionProtocolFrame({
      runId,
      token,
      event: {
        kind: "result",
        report: {
          version: 1,
          outcome: "attention",
          reason: "review-findings",
          summary: "Two review findings need changes",
          subject: { type: "pull-request", id: "144", revision: "abc123" },
        },
      },
    });
    const decoder = createActionProtocolDecoder({ runId, token });
    const first = decoder.push(`before\n${frame.slice(0, 20)}`);
    const second = decoder.push(`${frame.slice(20)}after\n`);

    expect(`${first.output}${second.output}${decoder.finish()}`).toBe("before\nafter\n");
    expect([...first.events, ...second.events]).toEqual([
      {
        kind: "result",
        report: {
          version: 1,
          outcome: "attention",
          reason: "review-findings",
          summary: "Two review findings need changes",
          subject: { type: "pull-request", id: "144", revision: "abc123" },
        },
      },
    ]);
  });

  it("leaves frames for another run in ordinary output", () => {
    const foreignFrame = actionProtocolFrame({
      runId: "run-2",
      token: "token-2",
      event: {
        kind: "progress",
        progress: { version: 1, state: "waiting", summary: "Waiting for CI" },
      },
    });
    const decoder = createActionProtocolDecoder({ runId, token });
    const decoded = decoder.push(foreignFrame);

    expect(decoded.events).toEqual([]);
    expect(`${decoded.output}${decoder.finish()}`).toBe(foreignFrame);
  });

  it("emits framed reports in LastCode and readable fallback output elsewhere", () => {
    const writes: string[] = [];
    const reporter = createActionReporter({
      env: { [ACTION_RUN_ID_ENV]: runId, [ACTION_EVENT_TOKEN_ENV]: token },
      write: (data) => writes.push(data),
    });
    reporter.progress({ state: "working", summary: "Running tests", current: 1, total: 3 });
    reporter.result({ outcome: "success", summary: "All checks passed" });

    const decoder = createActionProtocolDecoder({ runId, token });
    const decoded = decoder.push(writes.join(""));
    expect(decoded.events.map((event) => event.kind)).toEqual(["progress", "result"]);

    const logs: string[] = [];
    createActionReporter({
      env: {},
      write: () => undefined,
      log: (line) => logs.push(line),
    }).result({ outcome: "blocked", summary: "Authentication is required" });
    expect(logs[0]).toContain("[lastcode-action] Result:");
    expect(logs[0]).toContain("Authentication is required");
  });

  it("drops malformed matching frames and reports them", () => {
    const decoder = createActionProtocolDecoder({ runId, token });
    const decoded = decoder.push(
      `\u001b]777;T3ActionEvent;${runId};${token};not-valid-base64\u0007visible`,
    );

    expect(decoded.events).toEqual([]);
    expect(decoded.invalidFrames).toBe(1);
    expect(`${decoded.output}${decoder.finish()}`).toBe("visible");
  });

  it("rejects oversized events before writing a frame", () => {
    expect(() =>
      actionProtocolFrame({
        runId,
        token,
        event: {
          kind: "result",
          report: {
            version: 1,
            outcome: "success",
            summary: "Artifacts are ready",
            artifacts: Array.from({ length: 8 }, (_, index) => ({
              label: `Artifact ${index}`,
              url: `https://example.com/${"x".repeat(1_900)}${index}`,
            })),
          },
        },
      }),
    ).toThrow("serialized characters");
  });
});
