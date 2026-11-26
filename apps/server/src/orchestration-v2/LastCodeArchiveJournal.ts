import type { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export interface LastCodeArchiveJournalScope {
  readonly role: "source" | "destination";
  readonly ownerEnvironmentId: EnvironmentId;
  readonly ownerThreadId: ThreadId;
}

export interface LastCodeArchiveJournalKey extends LastCodeArchiveJournalScope {
  readonly sourceArchiveCommandId: CommandId;
}

export interface LastCodeArchiveJournalRow extends LastCodeArchiveJournalKey {
  readonly stateJson: string;
  readonly revision: number;
}

export type LastCodeArchiveJournal = ReturnType<typeof makeLastCodeArchiveJournal>;

export const makeLastCodeArchiveJournal = (sql: SqlClient.SqlClient) => {
  const columns = sql`
    role,
    owner_environment_id AS "ownerEnvironmentId",
    owner_thread_id AS "ownerThreadId",
    source_archive_command_id AS "sourceArchiveCommandId",
    state_json AS "stateJson",
    revision
  `;
  const matchOwner = (scope: LastCodeArchiveJournalScope) => sql`
    role = ${scope.role}
    AND owner_environment_id = ${scope.ownerEnvironmentId}
    AND owner_thread_id = ${scope.ownerThreadId}
  `;
  const matchKey = (key: LastCodeArchiveJournalKey) => sql`
    ${matchOwner(key)} AND source_archive_command_id = ${key.sourceArchiveCommandId}
  `;

  const read = (key: LastCodeArchiveJournalKey) =>
    sql<LastCodeArchiveJournalRow>`
      SELECT ${columns}
      FROM lastcode_archive_journal
      WHERE ${matchKey(key)}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows): LastCodeArchiveJournalRow | null => rows[0] ?? null),
    );

  const listByOwner = (scope: LastCodeArchiveJournalScope) =>
    sql<LastCodeArchiveJournalRow>`
      SELECT ${columns}
      FROM lastcode_archive_journal
      WHERE ${matchOwner(scope)}
      ORDER BY source_archive_command_id
    `.pipe(NodeSqliteClient.readOnly);

  const insertOnce = (key: LastCodeArchiveJournalKey, stateJson: string) =>
    sql`
      INSERT INTO lastcode_archive_journal (
        role, owner_environment_id, owner_thread_id, source_archive_command_id, state_json
      )
      VALUES (
        ${key.role}, ${key.ownerEnvironmentId}, ${key.ownerThreadId}, ${key.sourceArchiveCommandId}, ${stateJson}
      )
      ON CONFLICT (role, owner_environment_id, owner_thread_id, source_archive_command_id) DO NOTHING
      RETURNING 1
    `.pipe(
      Effect.map((rows): "inserted" | "exists" => (rows.length === 1 ? "inserted" : "exists")),
    );

  const compareAndReplace = (
    key: LastCodeArchiveJournalKey,
    expectedRevision: number,
    stateJson: string,
  ) =>
    sql`
      UPDATE lastcode_archive_journal
      SET state_json = ${stateJson}, revision = revision + 1
      WHERE ${matchKey(key)} AND revision = ${expectedRevision}
      RETURNING 1
    `.pipe(Effect.map((rows): "applied" | "stale" => (rows.length === 1 ? "applied" : "stale")));

  return { read, listByOwner, insertOnce, compareAndReplace };
};
