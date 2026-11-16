// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

// Windows runner temp paths use 8.3 names; canonicalize to long names before equality checks.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Bootstrap must not load Effect into every isolated test worker.
if (process.platform === "win32") {
  try {
    const longForm = NodeFS.realpathSync.native(NodeOS.tmpdir());
    process.env.TEMP = longForm;
    process.env.TMP = longForm;
  } catch {}
}
