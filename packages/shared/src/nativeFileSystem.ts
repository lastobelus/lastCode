// @effect-diagnostics nodeBuiltinImport:off -- Physical filesystem operations must not enter Electron's virtual archives.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";

export const isElectron = process.versions.electron !== undefined;

// Electron's archive-aware stat/realpath retain archive descriptors and report
// synthetic identities. Keep module loading unchanged; use raw I/O for worktrees.
const original = isElectron
  ? (NodeModule.createRequire(import.meta.url)("original-fs") as typeof NodeFS)
  : undefined;

export const fs = original ?? NodeFS;
export const promises = original?.promises ?? NodeFSP;
