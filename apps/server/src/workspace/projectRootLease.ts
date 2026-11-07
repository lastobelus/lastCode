import * as Effect from "effect/Effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const projectRoots = Semaphore.makeUnsafe(1);

/** Serialize project-root claims with the final isolation and removal of a workspace. */
export const withProjectRootLease = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  projectRoots.withPermit(effect);

export const canonicalProjectRoot = Effect.fn("canonicalProjectRoot")(
  function* (value: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let candidate = path.resolve(value);
    const missing: string[] = [];
    let links = 0;
    for (;;) {
      const resolved = yield* fs.realPath(candidate).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (resolved !== null) return path.join(resolved, ...missing);
      const link = yield* fs.readLink(candidate).pipe(
        Effect.catchIf(
          (cause) =>
            cause.reason._tag === "NotFound" ||
            (cause.cause instanceof Error &&
              "code" in cause.cause &&
              cause.cause.code === "EINVAL"),
          () => Effect.succeed(null),
        ),
      );
      if (link !== null) {
        if (++links > 40) return yield* Effect.fail(new Error("Project root cannot be verified."));
        candidate = path.resolve(path.dirname(candidate), link);
        continue;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate)
        return yield* Effect.fail(new Error("Project root cannot be verified."));
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  },
  Effect.provide(Layer.merge(NodePath.layer, NodeFileSystem.layer)),
);
