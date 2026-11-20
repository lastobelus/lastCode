// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Completed-tree fixture regeneration.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function regenerateMuseInstructions(ndjson: string): string {
  const lines = ndjson.split("\n");
  const header: unknown = JSON.parse(lines[0]!);
  if (
    !isRecord(header) ||
    header.provider !== "muse" ||
    !isRecord(header.metadata) ||
    typeof header.metadata.model !== "string"
  ) {
    throw new Error("Expected a Muse transcript with a recorded model.");
  }
  const model = header.metadata.model;
  const sections = /<(runtime_info|pull_request_linking|preview_handoffs)>[\s\S]*?<\/\1>/g;
  let currentSections = new Map<string | undefined, string>();
  let turns = 0;
  const result = lines
    .map((line) => {
      if (!line.trim()) return line;
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry) || !isRecord(entry.frame) || !isRecord(entry.frame.params)) return line;
      const frame = entry.frame;
      const params = entry.frame.params;
      if (entry.type === "expect_outbound" && frame.method === "turn/start") {
        const first: unknown = Array.isArray(params.input) ? params.input[0] : undefined;
        if (
          !isRecord(first) ||
          first.type !== "text" ||
          typeof first.text !== "string" ||
          !first.text.startsWith("<runtime_info>")
        ) {
          throw new Error("Expected turn/start input[0] to contain runtime instructions.");
        }
        if (params.reasoningEffort !== undefined && typeof params.reasoningEffort !== "string") {
          throw new Error("Expected a recorded Muse reasoning effort.");
        }
        const instructions = buildRuntimeInstructions({
          harness: "Muse Code",
          model,
          reasoningEffort: params.reasoningEffort,
        });
        currentSections = new Map(
          [...instructions.matchAll(sections)].map((match) => [match[1], match[0]]),
        );
        turns++;
        if (first.text === instructions) return line;
        first.text = instructions;
        return JSON.stringify(entry);
      }
      // Fixture echoes keep their recorded sections; preserve that extent and the user suffix.
      const item = params.item;
      if (
        entry.type === "emit_inbound" &&
        isRecord(item) &&
        item.kind === "userMessage" &&
        typeof item.text === "string" &&
        item.text.startsWith("<runtime_info>")
      ) {
        const text = item.text.replace(
          /^<runtime_info>[\s\S]*?<\/runtime_info>(?:\n\n<(pull_request_linking|preview_handoffs)>[\s\S]*?<\/\1>)*/,
          (prefix) =>
            prefix.replace(sections, (_section, tag: string) => {
              const replacement = currentSections.get(tag);
              if (replacement === undefined) throw new Error(`Instruction section missing: ${tag}`);
              return replacement;
            }),
        );
        if (text === item.text) return line;
        item.text = text;
        return JSON.stringify(entry);
      }
      return line;
    })
    .join("\n");
  if (turns === 0) throw new Error("Expected at least one recorded Muse turn/start.");
  return result;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const fixtures = new URL("../src/orchestration-v2/testkit/fixtures/", import.meta.url);
  for (const entry of NodeFS.readdirSync(fixtures, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = new URL(`${entry.name}/muse_transcript.ndjson`, fixtures);
    if (!NodeFS.existsSync(file)) continue;
    const before = NodeFS.readFileSync(file, "utf8");
    const after = regenerateMuseInstructions(before);
    if (after !== before) NodeFS.writeFileSync(file, after);
  }
  console.log("Regenerated Muse replay instruction fields; recorded behavior preserved.");
}
