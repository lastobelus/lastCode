import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

class PartialOutputSink extends Context.Reference<((chunk: string) => void) | undefined>(
  "checkChanged/PartialOutputSink",
  { defaultValue: () => undefined },
) {}

export const collectCheckOutput = Effect.fn("checkChanged.collectOutput")(function* (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
) {
  const append = yield* PartialOutputSink;
  const chunks: Array<string> = [];
  yield* Stream.runForEach(Stream.decodeText(stream), (chunk) =>
    Effect.sync(() => {
      chunks.push(chunk);
      append?.(chunk);
    }),
  );
  return chunks.join("");
});

const preserveCheckOutput = Effect.fn("checkChanged.preserveOutput")(
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

export const preserveStepOutput = <R>(
  root: string,
  run: Effect.Effect<{ readonly ok: boolean; readonly output: string }, never, R>,
) => {
  let chunks: Array<string> = [];
  return {
    run: Effect.suspend(() => {
      chunks = [];
      return run.pipe(
        Effect.provideService(PartialOutputSink, (chunk) => {
          chunks.push(chunk);
        }),
      );
    }).pipe(
      Effect.flatMap((result) =>
        preserveCheckOutput(root, result).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              chunks = [];
            }),
          ),
        ),
      ),
    ),
    onTimeout: Effect.suspend(() => {
      const output = chunks.join("");
      chunks = [];
      return preserveCheckOutput(root, { ok: false, output });
    }),
  };
};
