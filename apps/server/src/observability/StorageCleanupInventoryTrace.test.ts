import { assert, it } from "@effect/vitest";

import { formatTraceSummary, makeTraceSpanSummary } from "../cli/trace.ts";
import { STORAGE_CLEANUP_INVENTORY_ATTRIBUTE } from "./StorageCleanupInventoryTrace.ts";

it("summarizes measured cleanup inventory without dropping older sweep spans", () => {
  const summarizer = makeTraceSpanSummary();
  const span = {
    name: "StorageCleanup.sweep",
    durationMs: 5000,
    endTimeUnixNano: "1000000",
  };
  const metrics = {
    processCaptures: 1,
    processCaptureMs: 12,
    uniquePaths: 90,
    pathResolutions: 100,
    directoryChecks: 16,
    pathResolutionMs: 1600,
    treeWalks: 5,
    treeWalkMs: 3000,
    objectsVisited: 50_000,
  };
  summarizer.addLine(JSON.stringify(span));
  for (const value of [metrics, metrics, "malformed"]) {
    summarizer.addLine(
      JSON.stringify({
        ...span,
        attributes: { [STORAGE_CLEANUP_INVENTORY_ATTRIBUTE]: value },
      }),
    );
  }
  const summary = summarizer.finish();
  assert.strictEqual(summary.spanCount, 4);
  assert.strictEqual(summary.skippedLineCount, 0);
  const formatted = formatTraceSummary(summary, 25);
  assert.include(formatted, "Storage cleanup inventory (2 measured)");
  assert.include(formatted, "Process captures  2 in 24ms");
  assert.include(
    formatted,
    "Path resolutions  200 for 180 distinct paths counted per sweep with 32 directory checks in 3.2s",
  );
  assert.include(formatted, "Tree walks        10 visiting 100000 objects in 6s");
});
