import { createWorktreeSuspensionStore } from "../worktreeSuspension.ts";

const [storeRoot, snapshotId, quarantineParent] = process.argv.slice(2);
if (storeRoot === undefined || snapshotId === undefined || quarantineParent === undefined) {
  throw new Error("Missing owned fixture arguments");
}
const store = createWorktreeSuspensionStore({
  storeRoot,
  onBoundary: async (phase) => {
    if (phase === "removing") {
      process.send?.({ phase });
      await new Promise<void>(() => {});
    }
  },
});
await store.isolate(snapshotId, { quarantineParent });
await store.removeIsolated(snapshotId);
