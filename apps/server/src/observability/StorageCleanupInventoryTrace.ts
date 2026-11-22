import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const STORAGE_CLEANUP_INVENTORY_ATTRIBUTE = "storage_cleanup.inventory";

const StorageCleanupInventoryTrace = Schema.Struct({
  processCaptures: Schema.Finite,
  processCaptureMs: Schema.Finite,
  uniquePaths: Schema.Finite,
  pathResolutions: Schema.Finite,
  directoryChecks: Schema.Finite,
  pathResolutionMs: Schema.Finite,
  treeWalks: Schema.Finite,
  treeWalkMs: Schema.Finite,
  objectsVisited: Schema.Finite,
});

export const emptyStorageCleanupInventoryTrace = () => ({
  processCaptures: 0,
  processCaptureMs: 0,
  uniquePaths: 0,
  pathResolutions: 0,
  directoryChecks: 0,
  pathResolutionMs: 0,
  treeWalks: 0,
  treeWalkMs: 0,
  objectsVisited: 0,
});

const decodeInventory = Schema.decodeUnknownOption(StorageCleanupInventoryTrace);

export const makeStorageCleanupInventorySummary = () => {
  const totals = emptyStorageCleanupInventoryTrace();
  const keys = Object.keys(totals) as Array<keyof typeof totals>;
  let sweeps = 0;
  return {
    add(name: string, value: unknown) {
      if (name !== "StorageCleanup.sweep") return;
      const metrics = decodeInventory(value);
      if (Option.isNone(metrics)) return;
      sweeps++;
      for (const key of keys) totals[key] += metrics.value[key];
    },
    finish: () => ({ sweeps, totals }),
  };
};

export const formatStorageCleanupInventory = (
  { sweeps, totals }: ReturnType<ReturnType<typeof makeStorageCleanupInventorySummary>["finish"]>,
  formatMs: (value: number) => string,
) =>
  sweeps === 0
    ? []
    : [
        "",
        `Storage cleanup inventory (${sweeps} measured)`,
        `  Process captures  ${totals.processCaptures} in ${formatMs(totals.processCaptureMs)}`,
        `  Path resolutions  ${totals.pathResolutions} for ${totals.uniquePaths} distinct paths counted per sweep with ${totals.directoryChecks} directory checks in ${formatMs(totals.pathResolutionMs)}`,
        `  Tree walks        ${totals.treeWalks} visiting ${totals.objectsVisited} objects in ${formatMs(totals.treeWalkMs)}`,
      ];
