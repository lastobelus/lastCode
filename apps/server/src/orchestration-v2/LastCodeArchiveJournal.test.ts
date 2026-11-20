import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import {
  makeLastCodeArchiveJournal,
  type LastCodeArchiveJournalKey,
} from "./LastCodeArchiveJournal.ts";

const sourceKey: LastCodeArchiveJournalKey = {
  role: "source",
  ownerEnvironmentId: EnvironmentId.make("owner-environment"),
  ownerThreadId: ThreadId.make("owner-thread"),
  sourceArchiveCommandId: CommandId.make("archive-1"),
};
const destinationKey: LastCodeArchiveJournalKey = { ...sourceKey, role: "destination" };

it.layer(Sqlite.layerMemory)("archive journal", (it) => {
  it.effect("scopes generations by role, owner environment and owner thread", () =>
    Effect.gen(function* () {
      const journal = makeLastCodeArchiveJournal(yield* SqlClient.SqlClient);
      const nextGeneration = { ...sourceKey, sourceArchiveCommandId: CommandId.make("archive-2") };
      const otherEnvironment = {
        ...sourceKey,
        ownerEnvironmentId: EnvironmentId.make("other-environment"),
      };
      const otherThread = { ...sourceKey, ownerThreadId: ThreadId.make("other-thread") };
      const keys = [sourceKey, nextGeneration, destinationKey, otherEnvironment, otherThread];
      const expectedRows = keys.map((key, index) => ({
        ...key,
        revision: 0,
        stateJson: JSON.stringify({ index }),
      }));

      for (const row of expectedRows) {
        assert.equal(yield* journal.insertOnce(row, row.stateJson), "inserted");
      }
      for (const row of expectedRows) {
        assert.deepStrictEqual(yield* journal.read(row), row);
      }
      assert.deepStrictEqual(yield* journal.listByOwner(sourceKey), expectedRows.slice(0, 2));
      assert.deepStrictEqual(yield* journal.listByOwner(destinationKey), expectedRows.slice(2, 3));
    }),
  );

  it.effect("reserves a missing generation and replaces it only at the current revision", () =>
    Effect.gen(function* () {
      const journal = makeLastCodeArchiveJournal(yield* SqlClient.SqlClient);
      const destinationKey = {
        ...sourceKey,
        role: "destination" as const,
        sourceArchiveCommandId: CommandId.make("archive-reservation"),
      };
      const reserved = '{"session":"session-1","fenced":true}';
      const receipt = '{"session":"session-1","cohort":["thread-2","thread-1"]}';

      assert.isNull(yield* journal.read(destinationKey));
      assert.equal(yield* journal.compareAndReplace(destinationKey, 0, receipt), "stale");
      assert.equal(yield* journal.insertOnce(destinationKey, reserved), "inserted");
      assert.equal(yield* journal.insertOnce(destinationKey, receipt), "exists");
      assert.deepStrictEqual(yield* journal.read(destinationKey), {
        ...destinationKey,
        revision: 0,
        stateJson: reserved,
      });

      assert.equal(yield* journal.compareAndReplace(destinationKey, 0, receipt), "applied");
      assert.equal(yield* journal.compareAndReplace(destinationKey, 0, reserved), "stale");
      assert.deepStrictEqual(yield* journal.read(destinationKey), {
        ...destinationKey,
        revision: 1,
        stateJson: receipt,
      });

      assert.equal(yield* journal.compareAndReplace(destinationKey, 1, receipt), "applied");
      assert.equal((yield* journal.read(destinationKey))?.revision, 2);
    }),
  );
});

it.effect("reads the exact payload and revision after reopening the database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "archive-journal-" });
    const filename = path.join(directory, "state.sqlite");
    const receipt = '{ "session": "session-1", "cohort": ["thread-2", "thread-1"] }';

    yield* Effect.gen(function* () {
      const journal = makeLastCodeArchiveJournal(yield* SqlClient.SqlClient);
      assert.equal(yield* journal.insertOnce(destinationKey, "{}"), "inserted");
      assert.equal(yield* journal.compareAndReplace(destinationKey, 0, receipt), "applied");
    }).pipe(Effect.provide(Sqlite.layerFromPath(filename)));

    yield* Effect.gen(function* () {
      const journal = makeLastCodeArchiveJournal(yield* SqlClient.SqlClient);
      assert.deepStrictEqual(yield* journal.read(destinationKey), {
        ...destinationKey,
        revision: 1,
        stateJson: receipt,
      });
    }).pipe(Effect.provide(Sqlite.layerFromPath(filename)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
