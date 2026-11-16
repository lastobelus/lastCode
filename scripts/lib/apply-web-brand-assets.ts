// @effect-diagnostics nodeBuiltinImport:off -- Compiler/release adapters transform exact known assets before publication.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assertUnpublishedGeneratedBuildTarget } from "@t3tools/shared/generatedBuildOwnership";
import type { WebAssetBrand } from "./brand-assets.ts";
import { resolveLastCodeWebIconOverrides } from "./lastcode-brand-assets.ts";

export function applyWebBrandAssetsToDirectory(
  repoRoot: string,
  brand: WebAssetBrand,
  directory: string,
) {
  const target = NodeFS.realpathSync(NodePath.resolve(repoRoot, directory));
  assertUnpublishedGeneratedBuildTarget(target);
  const overrides = resolveLastCodeWebIconOverrides(brand, target).map((override) => ({
    source: NodePath.resolve(repoRoot, override.sourceRelativePath),
    target: override.targetRelativePath,
  }));
  // Preflight all four exact paths; links and hardlinks cannot redirect an overwrite.
  for (const override of overrides) {
    if (!NodeFS.lstatSync(override.source).isFile())
      throw new Error("Brand source must be a regular file");
    let existing;
    try {
      existing = NodeFS.lstatSync(override.target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing && (!existing.isFile() || existing.nlink !== 1))
      throw new Error("Brand target must be an exclusive regular file");
  }
  for (const override of overrides) {
    try {
      NodeFS.unlinkSync(override.target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    NodeFS.copyFileSync(override.source, override.target, NodeFS.constants.COPYFILE_EXCL);
  }
}
