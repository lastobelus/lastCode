import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE lastcode_archive_journal (
      role TEXT NOT NULL CHECK (role IN ('source', 'destination')),
      owner_environment_id TEXT NOT NULL,
      owner_thread_id TEXT NOT NULL,
      source_archive_command_id TEXT NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
      PRIMARY KEY (role, owner_environment_id, owner_thread_id, source_archive_command_id)
    ) WITHOUT ROWID
  `;
});
