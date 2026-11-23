// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Standalone CI check reads the two generated measurements.
import * as NodeFS from "node:fs";

const measurements = [
  "claudeSystemAppendBytes",
  "codexAdditionalContextBytes",
  "mcpToolListJsonBytes",
] as const;

function readBytes(snapshot: unknown, revision: string, name: (typeof measurements)[number]) {
  const bytes =
    snapshot !== null && typeof snapshot === "object"
      ? (snapshot as Record<string, unknown>)[name]
      : undefined;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Invalid ${revision} measurement for ${name}.`);
  }
  return bytes;
}

export function compareAgentContextBudgets(base: unknown, pr: unknown, allowIncrease: boolean) {
  const changes = measurements.map((name) => {
    const before = readBytes(base, "base", name);
    const after = readBytes(pr, "PR", name);
    const delta = after - before;
    return {
      delta,
      line: `${name}: ${before} -> ${after} (${delta > 0 ? "+" : ""}${delta} bytes)`,
    };
  });
  const grew = changes.some(({ delta }) => delta > 0);
  return { grew, accepted: !grew || allowIncrease, lines: changes.map(({ line }) => line) };
}

if (import.meta.main) {
  const [, , basePath, prPath] = process.argv;
  if (!basePath || !prPath) {
    throw new Error("Usage: node scripts/lastcode-agent-context-budget.ts <base.json> <pr.json>");
  }
  const result = compareAgentContextBudgets(
    JSON.parse(NodeFS.readFileSync(basePath, "utf8")),
    JSON.parse(NodeFS.readFileSync(prPath, "utf8")),
    process.env.ALLOW_INCREASE === "true",
  );
  const status = result.grew
    ? result.accepted
      ? "Accepted by the agent-context-increase label."
      : "Agent context grew compared to the base branch. Cut the added text and rerun the evals that cover it (evals/README.md), or ask a maintainer to add the agent-context-increase label."
    : "Agent context is no larger than the base branch.";
  const deltas = result.lines.join("\n");
  console.log(deltas);
  console.log(result.accepted ? status : `::error::${status}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${status}\n\n\`\`\`text\n${deltas}\n\`\`\`\n`,
    );
  }
  process.exitCode = result.accepted ? 0 : 1;
}
