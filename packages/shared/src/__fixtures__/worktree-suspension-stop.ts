// @effect-diagnostics nodeBuiltinImport:off -- This process-death fixture intercepts native subprocess metadata checks.
// oxlint-disable-next-line t3code/namespace-node-imports -- Patching this child requires the mutable default export before syncing ESM bindings.
import NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { createWorktreeSuspensionStore } from "../worktreeSuspension.ts";
import { fixtureMetadataExecFile } from "./worktree-suspension-metadata.ts";

const [storeRoot, snapshotId, quarantineParent] = process.argv.slice(2);
if (storeRoot === undefined || snapshotId === undefined || quarantineParent === undefined) {
  throw new Error("Missing owned fixture arguments");
}
NodeChildProcess.execFile = fixtureMetadataExecFile(
  NodePath.dirname(storeRoot),
  NodeChildProcess.execFile,
);
NodeModule.syncBuiltinESMExports();
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
