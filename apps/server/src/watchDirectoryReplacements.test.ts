// @effect-diagnostics nodeBuiltinImport:off - the probe test controls native directory watch callbacks.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { watchDirectoryPath } from "./watchDirectoryReplacements.ts";

vi.mock("node:fs", { spy: true });

it.effect.skipIf(!symlinksSupported)(
  "backs off stopped watches for an unchanged linked directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const entry = path.join(base, "linked");
      const first = path.join(base, "first", "themes");
      const second = path.join(base, "second", "themes");
      yield* fs.makeDirectory(first, { recursive: true });
      yield* fs.makeDirectory(second, { recursive: true });
      yield* fs.symlink(first, entry);
      const firstIdentity = yield* fs.stat(first);
      const secondIdentity = yield* fs.stat(second);
      let identity = firstIdentity;
      const events = yield* Queue.unbounded<"probe" | "refresh">();

      // Only the periodic probe drives this test. Native changes have their own cases.
      using _watch = vi
        .spyOn(NodeFS, "watch")
        .mockImplementation(
          () => Object.assign(new NodeEvents.EventEmitter(), { close() {} }) as NodeFS.FSWatcher,
        );
      // An ended child emits a final refresh, as it does when registration fails.
      yield* watchDirectoryPath(entry, Stream.succeed(undefined), Effect.succeed(false)).pipe(
        Stream.runForEach(() => Queue.offer(events, "refresh")),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            stat: (file) =>
              file === entry
                ? Queue.offer(events, "probe").pipe(Effect.map(() => identity))
                : fs.stat(file),
          }),
        ),
        Effect.forkScoped,
      );
      assert.deepEqual(yield* Queue.takeN(events, 3), ["probe", "probe", "refresh"]);

      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Queue.takeN(events, 3), ["probe", "probe", "refresh"]);

      yield* TestClock.adjust("1 second");
      assert.equal(yield* Queue.take(events), "probe");
      assert.equal(yield* Queue.size(events), 0);

      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Queue.takeN(events, 3), ["probe", "probe", "refresh"]);

      identity = secondIdentity;
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Queue.takeN(events, 3), ["probe", "probe", "refresh"]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(!symlinksSupported)(
  "rebuilds when a probe sees a tree other than the one the watches were acquired on",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const entry = path.join(base, "linked");
      const first = path.join(base, "first");
      const second = path.join(base, "second");
      yield* fs.makeDirectory(first);
      yield* fs.makeDirectory(second);
      yield* fs.symlink(first, entry);
      const a = yield* fs.stat(first);
      const b = yield* fs.stat(second);
      // Probe A, acquire A, probe B, swap back and acquire A, then B returns for the next probe.
      const identities = [a, a, b, a, b, b];
      const refreshes = yield* Queue.unbounded<void>();

      yield* watchDirectoryPath(
        entry,
        Stream.concat(Stream.succeed(undefined), Stream.never),
        Effect.succeed(false),
      ).pipe(
        Stream.runForEach(() => Queue.offer(refreshes, undefined)),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            stat: (file) =>
              file === entry ? Effect.sync(() => identities.shift() ?? b) : fs.stat(file),
          }),
        ),
        Effect.forkScoped,
      );
      yield* Queue.takeN(refreshes, 3);
      assert.deepEqual(identities, []);
    }).pipe(Effect.provide(NodeServices.layer)),
);
