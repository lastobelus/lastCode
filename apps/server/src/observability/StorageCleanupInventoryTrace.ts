import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const STORAGE_CLEANUP_INVENTORY_ATTRIBUTE = "storage_cleanup.inventory";

const StorageCleanupInventoryTrace = Schema.Struct({
  partial: Schema.Boolean,
  processCaptures: Schema.Finite,
  processCaptureMs: Schema.Finite,
  uniquePaths: Schema.Finite,
  pathResolutions: Schema.Finite,
  cachedPathChecks: Schema.Finite,
  cachedPathCheckMs: Schema.Finite,
  directoryChecks: Schema.Finite,
  directoryCheckMs: Schema.Finite,
  pathResolutionMs: Schema.Finite,
  treeWalks: Schema.Finite,
  treeWalkMs: Schema.Finite,
  objectsVisited: Schema.Finite,
});

export const emptyStorageCleanupInventoryTrace = () => ({
  partial: false,
  processCaptures: 0,
  processCaptureMs: 0,
  uniquePaths: 0,
  pathResolutions: 0,
  cachedPathChecks: 0,
  cachedPathCheckMs: 0,
  directoryChecks: 0,
  directoryCheckMs: 0,
  pathResolutionMs: 0,
  treeWalks: 0,
  treeWalkMs: 0,
  objectsVisited: 0,
});

const decodeInventory = Schema.decodeUnknownOption(StorageCleanupInventoryTrace);

type InventorySweep = {
  readonly endMs: number;
  readonly inventory: typeof StorageCleanupInventoryTrace.Type;
};

export const makeStorageCleanupInventorySummary = () => {
  const sweeps: InventorySweep[] = [];
  return {
    add(name: string, endMs: number, value: unknown) {
      if (name !== "StorageCleanup.sweep") return;
      const metrics = decodeInventory(value);
      if (Option.isSome(metrics)) sweeps.push({ endMs, inventory: metrics.value });
    },
    finish: () => sweeps.toSorted((left, right) => right.endMs - left.endMs),
  };
};

export const formatStorageCleanupInventory = (
  sweeps: readonly InventorySweep[],
  formatEnd: (value: number) => string,
  formatMs: (value: number) => string,
) =>
  sweeps.length === 0
    ? []
    : [
        "",
        "Storage cleanup usage inventory by sweep",
        ...sweeps.flatMap(({ endMs, inventory }) => [
          `  ${formatEnd(endMs)}${inventory.partial ? " (partial)" : ""}`,
          `    Native capture attempts  ${inventory.processCaptures} in ${formatMs(inventory.processCaptureMs)}`,
          `    Path resolutions         ${inventory.pathResolutions} for ${inventory.uniquePaths} distinct paths in ${formatMs(inventory.pathResolutionMs)}`,
          `    Cached path checks       ${inventory.cachedPathChecks} in ${formatMs(inventory.cachedPathCheckMs)}`,
          `    Directory checks         ${inventory.directoryChecks} in ${formatMs(inventory.directoryCheckMs)}`,
          `    Tree walks               ${inventory.treeWalks} visiting ${inventory.objectsVisited} objects in ${formatMs(inventory.treeWalkMs)}`,
        ]),
      ];
