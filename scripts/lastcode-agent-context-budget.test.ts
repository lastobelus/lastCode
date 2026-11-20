import { describe, expect, it } from "vite-plus/test";
import { compareAgentContextBudgets } from "./lastcode-agent-context-budget.ts";

const base = {
  claudeSystemAppendBytes: 100,
  codexAdditionalContextBytes: 200,
  mcpToolListJsonBytes: 300,
};

describe("LastCode PR agent context budget", () => {
  it.each([false, true])(
    "reports each delta and requires the label for any growth (%s)",
    (label) => {
      const result = compareAgentContextBudgets(
        base,
        { ...base, claudeSystemAppendBytes: 90, mcpToolListJsonBytes: 304 },
        label,
      );

      expect(result.accepted).toBe(label);
      expect(result.grew).toBe(true);
      expect(result.lines).toEqual([
        "claudeSystemAppendBytes: 100 -> 90 (-10 bytes)",
        "codexAdditionalContextBytes: 200 -> 200 (0 bytes)",
        "mcpToolListJsonBytes: 300 -> 304 (+4 bytes)",
      ]);
    },
  );

  it.each([299, 300])(
    "accepts unchanged or smaller measurements without the label (%s)",
    (bytes) => {
      expect(
        compareAgentContextBudgets(base, { ...base, mcpToolListJsonBytes: bytes }, false),
      ).toMatchObject({ accepted: true, grew: false });
    },
  );

  it("fails on missing or invalid measurements even with the label", () => {
    expect(() => compareAgentContextBudgets({}, base, true)).toThrow(
      "Invalid base measurement for claudeSystemAppendBytes",
    );
    expect(() =>
      compareAgentContextBudgets(base, { ...base, mcpToolListJsonBytes: -1 }, true),
    ).toThrow("Invalid PR measurement for mcpToolListJsonBytes");
  });
});
