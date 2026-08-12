import { describe, expect, it } from "vite-plus/test";

import { checkpointRunHistoryPath } from "./lastcode-checkpoint-history.ts";

describe("checkpoint run history", () => {
  it("uses the private LastCode automation directory", () => {
    expect(checkpointRunHistoryPath("/Users/example")).toBe(
      "/Users/example/.lastcode/automation/checkpoint-runs.jsonl",
    );
  });
});
