// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function positive(raw: string, name: string, integer = true) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`--${name} requires a positive ${integer ? "integer" : "number"}.`);
  }
  return value;
}

export function isInside(parent: string, child: string) {
  const rel = NodePath.relative(parent, child);
  return (
    rel !== "" && rel !== ".." && !rel.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(rel)
  );
}

export function existingFile(base: string, path: string) {
  if (!isInside(base, path)) throw new Error("Log or state path is outside --base-dir.");
  const target = NodeFS.realpathSync(path);
  if (!isInside(base, target)) throw new Error("Log or state link points outside --base-dir.");
  return target;
}

export function outsideHome(home: string, path: string) {
  const absolute = NodePath.resolve(path);
  const target = NodePath.join(
    NodeFS.realpathSync(NodePath.dirname(absolute)),
    NodePath.basename(absolute),
  );
  if (target === home || isInside(home, target))
    throw new Error("Output must be outside --server-home.");
  if (NodeFS.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Output cannot be a symlink.");
  }
  return target;
}
