import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const STORAGE_CLEANUP_INVENTORY_ATTRIBUTE = "storage_cleanup.inventory";

const StorageCleanupWalkTrigger = Schema.Struct({
  kind: Schema.Literals(["vnode", "socket"]),
  process: Schema.String,
  walks: Schema.Finite,
});

export type StorageCleanupWalkTrigger = typeof StorageCleanupWalkTrigger.Type;
export type StorageCleanupWalkReason =
  | "vnode-ENOENT"
  | "vnode-ESRCH"
  | "vnode-EACCES"
  | "vnode-EPERM"
  | "vanished-socket";

const StorageCleanupInventoryCounters = Schema.Struct({
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
  targetRevalidations: Schema.Finite,
  targetRevalidationMs: Schema.Finite,
  skippedRecentUsageChecks: Schema.optional(Schema.Finite),
  walkReasons: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  missingIdentityChecks: Schema.optional(Schema.Finite),
  walkTriggers: Schema.optional(Schema.Array(StorageCleanupWalkTrigger)),
});

const StorageCleanupInventoryTrace = Schema.Struct({
  ...StorageCleanupInventoryCounters.fields,
  worktrees: Schema.optional(StorageCleanupInventoryCounters),
});

export const emptyStorageCleanupInventoryTrace = () => ({
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
  targetRevalidations: 0,
  targetRevalidationMs: 0,
  skippedRecentUsageChecks: 0,
  walkReasons: {} as Partial<Record<StorageCleanupWalkReason, number>>,
  missingIdentityChecks: 0,
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
) => {
  const formatCounters = (inventory: typeof StorageCleanupInventoryCounters.Type) => [
    `Native capture attempts  ${inventory.processCaptures} in ${formatMs(inventory.processCaptureMs)}`,
    `Path resolutions         ${inventory.pathResolutions} for ${inventory.uniquePaths} distinct paths in ${formatMs(inventory.pathResolutionMs)}`,
    `Cached path checks       ${inventory.cachedPathChecks} in ${formatMs(inventory.cachedPathCheckMs)}`,
    `Directory checks         ${inventory.directoryChecks} in ${formatMs(inventory.directoryCheckMs)}`,
    `Tree walks               ${inventory.treeWalks} visiting ${inventory.objectsVisited} objects in ${formatMs(inventory.treeWalkMs)}`,
    ...(inventory.walkReasons && Object.keys(inventory.walkReasons).length > 0
      ? [
          `Walk reasons             ${Object.entries(inventory.walkReasons)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reason, walks]) => `${reason} (${walks})`)
            .join(", ")}`,
        ]
      : []),
    ...(inventory.missingIdentityChecks
      ? [`Missing identity checks  ${inventory.missingIdentityChecks}`]
      : []),
    ...(inventory.walkTriggers && inventory.walkTriggers.length > 0
      ? [
          `Walk triggers            ${inventory.walkTriggers
            .map((trigger) => `${trigger.kind} ${trigger.process} (${trigger.walks})`)
            .join(", ")}`,
        ]
      : []),
    ...(inventory.skippedRecentUsageChecks !== undefined
      ? [`Recent-use skips         ${inventory.skippedRecentUsageChecks}`]
      : []),
    `Target revalidations     ${inventory.targetRevalidations} in ${formatMs(inventory.targetRevalidationMs)}`,
  ];
  return sweeps.length === 0
    ? []
    : [
        "",
        "Storage cleanup usage inventory by completed sweep",
        ...sweeps.flatMap(({ endMs, inventory }) => [
          `  ${formatEnd(endMs)}`,
          ...formatCounters(inventory).map((line) => `    ${line}`),
          ...(inventory.worktrees === undefined
            ? []
            : [
                "    Worktree consumers",
                ...formatCounters(inventory.worktrees).map((line) => `      ${line}`),
              ]),
        ]),
      ];
};
