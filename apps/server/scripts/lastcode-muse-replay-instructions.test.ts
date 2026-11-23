// @effect-diagnostics nodeBuiltinImport:off -- Uses a recorded fixture as the preservation oracle.
import * as NodeFS from "node:fs";
import { expect, it } from "@effect/vitest";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { regenerateMuseInstructions } from "./lastcode-muse-replay-instructions.ts";

it.each(["all", "echoes"])("regenerates stale %s without changing recorded behavior", (scope) => {
  const recorded = NodeFS.readFileSync(
    new URL(
      "../src/orchestration-v2/testkit/fixtures/multi_turn/muse_transcript.ndjson",
      import.meta.url,
    ),
    "utf8",
  );
  const stale = recorded
    .split("\n")
    .map((line) => {
      if (scope === "echoes" && !line.includes('"type":"emit_inbound"')) return line;
      return line
        .replaceAll(/<runtime_info>[\s\S]*?<\/runtime_info>/g, "<runtime_info>stale</runtime_info>")
        .replaceAll(
          /<pull_request_linking>[\s\S]*?<\/pull_request_linking>/g,
          "<pull_request_linking>stale</pull_request_linking>",
        );
    })
    .join("\n");
  const generated = regenerateMuseInstructions(stale);
  expect(generated).not.toContain("<runtime_info>stale</runtime_info>");
  expect(generated).not.toContain("<pull_request_linking>stale</pull_request_linking>");
  const instructions = buildRuntimeInstructions({
    harness: "Muse Code",
    model: "muse-spark-1.3-contributor",
    reasoningEffort: "high",
  });
  expect(generated).toContain(JSON.stringify(instructions));
  const withoutInstructions = (value: string) =>
    value.replaceAll(
      /<(runtime_info|pull_request_linking|preview_handoffs)>[\s\S]*?<\/\1>/g,
      "<instructions>",
    );
  expect(withoutInstructions(generated)).toBe(withoutInstructions(stale));
  expect(generated).toBe(regenerateMuseInstructions(recorded));
  expect(regenerateMuseInstructions(generated)).toBe(generated);
});
