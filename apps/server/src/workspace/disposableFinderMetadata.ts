import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** A directory or link named .DS_Store is not evidence of disposable Finder data. */
// Called per filesystem entry; the enclosing cleanup operation owns the span.
export const isDisposableFinderMetadata = Effect.fnUntraced(function* (target: string) {
  const path = yield* Path.Path;
  if (path.basename(target) !== ".DS_Store") return false;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readLink(target).pipe(
    Effect.as(false),
    Effect.catchIf(
      (error) =>
        error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL",
      () => fs.stat(target).pipe(Effect.map((stat) => stat.type === "File")),
    ),
    Effect.orElseSucceed(() => false),
  );
});
