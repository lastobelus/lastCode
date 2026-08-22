import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { writeFileStringAtomically } from "./atomicWrite.ts";

it.layer(NodeServices.layer)("atomic write", (it) => {
  it.effect("syncs the file and parent directory before a durable write completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const destination = path.join(root, "nested", "record.json");
        const events = yield* Ref.make<ReadonlyArray<string>>([]);
        const append = (event: string) => Ref.update(events, (current) => [...current, event]);
        const observed = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (filePath, contents, options) =>
            fs.writeFileString(filePath, contents, options).pipe(Effect.tap(() => append("write"))),
          open: (filePath, options) =>
            fs.open(filePath, options).pipe(
              Effect.map((file) => ({
                ...file,
                sync: append(`sync:${filePath}`).pipe(Effect.andThen(file.sync)),
              })),
            ),
          rename: (fromPath, toPath) =>
            fs.rename(fromPath, toPath).pipe(Effect.tap(() => append("rename"))),
        });

        yield* writeFileStringAtomically({
          filePath: destination,
          contents: "durable\n",
          durable: true,
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));

        const recorded = yield* Ref.get(events);
        assert.deepStrictEqual(
          recorded.slice(0, 3).map((event) => event.split(":")[0]),
          ["write", "sync", "rename"],
        );
        assert.equal(recorded[3], `sync:${path.dirname(destination)}`);
      }),
    ),
  );
});
