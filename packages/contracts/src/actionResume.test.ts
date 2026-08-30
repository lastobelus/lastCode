import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ActionProgress,
  ActionReport,
  ActionResumeState,
  ActionRunInspection,
} from "./orchestration.ts";

const decodeActionProgress = Schema.decodeUnknownSync(ActionProgress);
const decodeActionReport = Schema.decodeUnknownSync(ActionReport);
const decodeActionResumeState = Schema.decodeUnknownSync(ActionResumeState);
const decodeActionRunInspection = Schema.decodeUnknownSync(ActionRunInspection);

describe("Action resume contracts", () => {
  it("decodes compact domain results independently from host lifecycle outcomes", () => {
    const report = decodeActionReport({
      version: 1,
      outcome: "attention",
      reason: "review-findings",
      summary: "Two review findings need changes",
      subject: {
        type: "pull-request",
        id: "144",
        revision: "abc123",
        url: "https://github.com/example/project/pull/144",
      },
      facts: { findings: "2", ci: "passed" },
      artifacts: [{ label: "Pull request", url: "https://github.com/example/project/pull/144" }],
    });

    expect(report.outcome).toBe("attention");
    expect(report.subject?.revision).toBe("abc123");
  });

  it("bounds authored progress and result presentation", () => {
    expect(() =>
      decodeActionProgress({
        version: 1,
        state: "working",
        summary: "x".repeat(280),
      }),
    ).not.toThrow();
    expect(() =>
      decodeActionProgress({
        version: 1,
        state: "working",
        summary: "x".repeat(281),
      }),
    ).toThrow();
    expect(() =>
      decodeActionProgress({
        version: 1,
        state: "working",
        summary: "Running\nchecks",
      }),
    ).toThrow();
    expect(() =>
      decodeActionReport({
        version: 1,
        outcome: "success",
        summary: "Done",
        artifacts: Array.from({ length: 9 }, (_, index) => ({
          label: `Artifact ${index}`,
          url: `https://example.com/${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeActionProgress({
        version: 1,
        state: "working",
        summary: "Running checks",
        current: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
    expect(() =>
      decodeActionProgress({
        version: 1,
        state: "working",
        summary: "Running checks",
        current: 3,
        total: 2,
      }),
    ).toThrow();
  });

  it("accepts only safe report links", () => {
    expect(() =>
      decodeActionReport({
        version: 1,
        outcome: "attention",
        summary: "Inspect the result",
        artifacts: [{ label: "Unsafe", url: "javascript:alert(1)" }],
      }),
    ).toThrow();
    expect(() =>
      decodeActionReport({
        version: 1,
        outcome: "attention",
        summary: "Inspect the result",
        artifacts: [{ label: "Credentials", url: "https://user:password@example.com/result" }],
      }),
    ).toThrow();
  });

  it("keeps structured fields optional for existing persisted lifecycle rows", () => {
    const state = decodeActionResumeState({
      runId: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      actionId: "qa",
      actionName: "QA",
      terminalId: "action-run-1",
      outcome: "succeeded",
      delivery: "delivered",
      startedAt: "2026-08-29T12:00:00.000Z",
      finishedAt: "2026-08-29T12:01:00.000Z",
      exitCode: 0,
      exitSignal: null,
    });

    expect(state.report).toBeUndefined();
    expect(state.progress).toBeUndefined();
  });

  it("decodes host-stamped running progress revisions", () => {
    const state = decodeActionResumeState({
      runId: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      actionId: "qa",
      actionName: "QA",
      terminalId: "action-run-1",
      outcome: "running",
      delivery: "armed",
      startedAt: "2026-08-29T12:00:00.000Z",
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
      revision: 2,
      progress: {
        version: 1,
        state: "working",
        summary: "Running checks",
        updatedAt: "2026-08-29T12:00:05.000Z",
      },
    });

    expect(state).toMatchObject({
      revision: 2,
      progress: { state: "working", summary: "Running checks" },
    });
  });

  it("bounds retained output returned by Action run inspection", () => {
    expect(() =>
      decodeActionRunInspection({
        runId: "run-1",
        actionName: "QA",
        lifecycleOutcome: "succeeded",
        exitCode: 0,
        exitSignal: null,
        outputTail: "x".repeat(12_001),
      }),
    ).toThrow();
  });
});
