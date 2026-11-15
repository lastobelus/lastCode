// @effect-diagnostics nodeBuiltinImport:off -- Local lockfile verification.
import * as NodeAssert from "node:assert";
import { parseAllDocuments } from "yaml";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";

interface DependencySettings {
  readonly catalog?: Record<string, string>;
  readonly overrides?: Record<string, string>;
  readonly patchedDependencies?: Record<string, unknown>;
}

export function verifyDerivedLockfile(settings: DependencySettings, lockfile: DependencySettings) {
  NodeAssert.deepStrictEqual(
    lockfile.overrides ?? {},
    resolveCatalogDependencies(settings.overrides ?? {}, settings.catalog ?? {}, "overrides"),
    "Regenerated lockfile lost pnpm overrides",
  );
  NodeAssert.deepStrictEqual(
    Object.keys(lockfile.patchedDependencies ?? {}).sort(),
    Object.keys(settings.patchedDependencies ?? {}).sort(),
    "Regenerated lockfile lost patchedDependencies",
  );
}

export function parseWorkspaceLockfile(text: string): DependencySettings {
  const workspace = parseAllDocuments(text).find(
    (document) => document.get("settings") !== undefined,
  );
  if (!workspace) throw new Error("No workspace settings in pnpm-lock.yaml");
  return workspace.toJS();
}
