import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const preserveCheckOutput = Effect.fn("checkChanged.preserveOutput")(
  function* (root: string, result: { readonly ok: boolean; readonly output: string }) {
    if (result.output.length <= 12_000) return { ...result, logPath: null };
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(root, "node_modules/.cache/check-changed-logs");
    yield* fs.makeDirectory(directory, { recursive: true });
    const run = yield* fs.makeTempDirectory({ directory, prefix: "step-" });
    const logPath = path.join(run, "output.log");
    yield* fs.writeFileString(logPath, result.output);
    return {
      ...result,
      output: `Output tail (earlier output saved in full):\n${result.output.slice(-6_000)}\nFull log: ${logPath}`,
      logPath,
    };
  },
  (effect, _root, result) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.succeed({
          ...result,
          output: `${result.output}\nCould not save full log: ${error.message}`,
          logPath: null,
        }),
      ),
    ),
);
