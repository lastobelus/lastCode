import { assert, it } from "@effect/vitest";

import { formatTraceSummary, makeTraceSpanSummary } from "../cli/trace.ts";
import {
  emptyStorageCleanupInventoryTrace,
  STORAGE_CLEANUP_INVENTORY_ATTRIBUTE,
} from "./StorageCleanupInventoryTrace.ts";

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
    cachedPathChecks: 400,
    cachedPathCheckMs: 582,
    directoryChecks: 16,
    directoryCheckMs: 114,
    pathResolutionMs: 1600,
    treeWalks: 5,
    treeWalkMs: 3000,
    objectsVisited: 50_000,
  };
  summarizer.addLine(JSON.stringify(span));
  const measurements = [
    metrics,
    { ...metrics, processCaptures: 2, pathResolutions: 123 },
    emptyStorageCleanupInventoryTrace(),
    "malformed",
  ];
  for (const [index, value] of measurements.entries()) {
    summarizer.addLine(
      JSON.stringify({
        ...span,
        endTimeUnixNano: String(BigInt(index + 1) * 1000000000n),
        attributes: { [STORAGE_CLEANUP_INVENTORY_ATTRIBUTE]: value },
      }),
    );
  }
  const summary = summarizer.finish();
  assert.strictEqual(summary.spanCount, 5);
  assert.strictEqual(summary.skippedLineCount, 0);
  assert.deepStrictEqual(
    summary.cleanupInventory.map(({ endMs, inventory }) => [
      endMs,
      inventory.processCaptures,
      inventory.pathResolutions,
    ]),
    [
      [3000, 0, 0],
      [2000, 2, 123],
      [1000, 1, 100],
    ],
  );
  const formatted = formatTraceSummary(summary, 25);
  assert.include(formatted, "Storage cleanup usage inventory by sweep");
  assert.include(formatted, "Native capture attempts  0 in 0ms");
  assert.include(formatted, "Native capture attempts  2 in 12ms");
  assert.include(formatted, "Native capture attempts  1 in 12ms");
  assert.include(formatted, "Path resolutions         123 for 90 distinct paths in 1.6s");
  assert.include(formatted, "Cached path checks       400 in 582ms");
  assert.include(formatted, "Directory checks         16 in 114ms");
  assert.include(formatted, "Tree walks               5 visiting 50000 objects in 3s");
});
