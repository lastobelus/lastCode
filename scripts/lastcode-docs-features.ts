#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  checkLastCodeReadmeFeatureBlock,
  decodeLastCodeDocsFeatureRegistryJson,
  renderLastCodeReadmeFeatureBlock,
  replaceLastCodeReadmeFeatureBlock,
  type SourcePathKind,
  validateLastCodeDocsFeatureRegistry,
} from "./lib/lastcode-docs-features.ts";

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const usage = Console.error(
  "Usage: node scripts/lastcode-docs-features.ts --check | --render-readme | --write-readme",
);

export const loadLastCodeDocsFeatureRegistry = Effect.fn("loadLastCodeDocsFeatureRegistry")(
  function* (repositoryRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registryPath = path.join(repositoryRoot, "docs/lastcode/features.json");
    const source = yield* fs.readFileString(registryPath);
    const decoded = yield* Effect.try(() => decodeLastCodeDocsFeatureRegistryJson(source));
    const sourcePathKinds = new Map<string, SourcePathKind>();

    for (const sourcePrefix of new Set(
      decoded.features.flatMap((feature) => feature.sourcePrefixes),
    )) {
      const sourcePath = path.join(repositoryRoot, sourcePrefix);
      const kind = yield* fs.stat(sourcePath).pipe(
        Effect.map((info): SourcePathKind | undefined => {
          if (info.type === "Directory") return "directory";
          if (info.type === "File") return "file";
          return undefined;
        }),
        Effect.orElseSucceed(() => undefined),
      );
      if (kind) sourcePathKinds.set(sourcePrefix, kind);
    }

    return yield* Effect.try(() =>
      validateLastCodeDocsFeatureRegistry(decoded, {
        sourcePathKind: (sourcePrefix) => sourcePathKinds.get(sourcePrefix),
      }),
    );
  },
);

export const main = Effect.fn("lastcodeDocsFeaturesMain")(function* (args: ReadonlyArray<string>) {
  if (args.length !== 1) {
    yield* usage;
    return 2;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* RepositoryRoot;
  const readmePath = path.join(repositoryRoot, "README.md");
  const registry = yield* loadLastCodeDocsFeatureRegistry(repositoryRoot);
  const [command] = args;

  if (command === "--render-readme") {
    yield* Console.log(renderLastCodeReadmeFeatureBlock(registry));
    return 0;
  }

  const readme = yield* fs.readFileString(readmePath);

  if (command === "--write-readme") {
    const updated = yield* Effect.try(() => replaceLastCodeReadmeFeatureBlock(readme, registry));
    if (updated !== readme) {
      yield* fs.writeFileString(readmePath, updated);
    }
    yield* Console.log(`Generated ${registry.features.length} LastCode README features.`);
    return 0;
  }

  if (command === "--check") {
    const status = yield* Effect.try(() => checkLastCodeReadmeFeatureBlock(readme, registry));
    if (status.active && !status.current) {
      yield* Console.error("README feature block is stale. Run npm run lastcode:docs:readme.");
      return 1;
    }
    const readmeStatus = status.active
      ? "README feature block is current."
      : "README feature block is not active.";
    yield* Console.log(`Validated ${registry.features.length} LastCode features. ${readmeStatus}`);
    return 0;
  }

  yield* usage;
  return 2;
});

if (import.meta.main) {
  main(process.argv.slice(2)).pipe(
    Effect.tap((exitCode) => Effect.sync(() => (process.exitCode = exitCode))),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
