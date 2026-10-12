import type { Plugin } from "vite-plus";
import type { createGeneratedBuildStage } from "@t3tools/shared/generatedBuildOwnership";
import { recordDependencyUse } from "@t3tools/shared/dependencyActivity";

/** Constructing/configuring the plugin is not compiler execution or dependency use. */
export function createBuildOwnershipPlugin(
  repoRoot: string,
  stage: ReturnType<typeof createGeneratedBuildStage>,
  now: () => number = Date.now,
): Plugin {
  let emitted = false;
  let executing = false;
  const noteUse = () => {
    try { recordDependencyUse(repoRoot, now()); }
    catch { console.warn("[web:build] Could not record dependency use."); }
  };
  const finishUse = () => {
    if (!executing) return;
    executing = false;
    noteUse();
  };
  return {
    name: "runner-owned-build-output",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      if (stage && config.build.outDir !== stage.directory) {
        stage.discard();
        throw new Error("Managed build output must use its private stage");
      }
    },
    buildStart() {
      emitted = false;
      executing = true;
      noteUse();
    },
    writeBundle() { emitted = true; },
    buildEnd(error) {
      if (error) {
        finishUse();
        if (!this.meta.watchMode) stage?.discard();
      }
    },
    renderError() { emitted = false; finishUse(); },
    closeBundle() {
      try {
        // A watched compiler retains its own private tree between emissions;
        // ownership never comes from scanning the real destination directory.
        if (emitted) stage?.publish(now(), undefined, this.meta.watchMode);
      } finally {
        finishUse();
        if (!this.meta.watchMode) stage?.discard();
      }
    },
    closeWatcher() { finishUse(); stage?.discard(); },
  };
}
