import { assert, it } from "@effect/vitest";

import { formatTraceSummary, makeTraceSpanSummary } from "../cli/trace.ts";
import {
  emptyStorageCleanupInventoryTrace,
  STORAGE_CLEANUP_INVENTORY_ATTRIBUTE,
} from "./StorageCleanupInventoryTrace.ts";

it("shows inventory for completed sweeps and retains all sweep spans", () => {
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
    targetRevalidations: 3,
    targetRevalidationMs: 225,
  };
  summarizer.addLine(JSON.stringify(span));
  const measurements = [
    { value: metrics },
    {
      value: {
        ...metrics,
        processCaptures: 2,
        pathResolutions: 123,
        skippedRecentUsageChecks: 4,
        walkReasons: { "vanished-socket": 2, "vnode-EACCES": 3 },
        missingIdentityChecks: 1,
        walkTriggers: [
          { kind: "socket", process: "worker", walks: 2 },
          { kind: "vnode", process: "node", walks: 3 },
        ],
        worktrees: {
          ...metrics,
          processCaptures: 6,
          processCaptureMs: 42,
          treeWalks: 8,
          walkTriggers: [{ kind: "socket", process: "preview", walks: 8 }],
        },
      },
    },
    { value: emptyStorageCleanupInventoryTrace() },
    { value: "malformed" },
    { value: metrics, exit: { _tag: "Interrupted" } },
    { value: metrics, exit: { _tag: "Failure" } },
  ];
  for (const [index, { value, exit }] of measurements.entries()) {
    summarizer.addLine(
      JSON.stringify({
        ...span,
        endTimeUnixNano: String(BigInt(index + 1) * 1000000000n),
        attributes: { [STORAGE_CLEANUP_INVENTORY_ATTRIBUTE]: value },
        exit,
      }),
    );
  }
  const summary = summarizer.finish();
  assert.strictEqual(summary.spanCount, 7);
  assert.strictEqual(summary.spans[0]?.interrupted, 1);
  assert.strictEqual(summary.spans[0]?.failures, 1);
  assert.strictEqual(summary.skippedLineCount, 0);
  assert.deepStrictEqual(
    summary.cleanupInventory.map(({ endMs, inventory }) => [
      endMs,
      inventory.processCaptures,
      inventory.pathResolutions,
      inventory.skippedRecentUsageChecks,
    ]),
    [
      [3000, 0, 0, 0],
      [2000, 2, 123, 4],
      [1000, 1, 100, undefined],
    ],
  );
  const formatted = formatTraceSummary(summary, 25);
  assert.include(formatted, "Storage cleanup usage inventory by completed sweep");
  assert.include(formatted, "Native capture attempts  0 in 0ms");
  assert.include(formatted, "Native capture attempts  2 in 12ms");
  assert.include(formatted, "Native capture attempts  1 in 12ms");
  assert.include(formatted, "Path resolutions         123 for 90 distinct paths in 1.6s");
  assert.include(formatted, "Cached path checks       400 in 582ms");
  assert.include(formatted, "Directory checks         16 in 114ms");
  assert.include(formatted, "Tree walks               5 visiting 50000 objects in 3s");
  assert.include(formatted, "Walk reasons             vanished-socket (2), vnode-EACCES (3)");
  assert.include(formatted, "Missing identity checks  1");
  assert.include(formatted, "Walk triggers            socket worker (2), vnode node (3)");
  assert.include(formatted, "Recent-use skips         4");
  assert.include(formatted, "Target revalidations     3 in 225ms");
  assert.include(formatted, "Worktree consumers\n      Native capture attempts  6 in 42ms");
  assert.include(formatted, "Walk triggers            socket preview (8)");
});
