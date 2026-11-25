import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const prefix = "lastcode_thread_read_";
export const authorityTables = [
  `${prefix}failures`,
  `${prefix}grants`,
  `${prefix}handoff_exceptions`,
  `${prefix}handoffs`,
  `${prefix}sessions`,
  `${prefix}generations`,
  `${prefix}generation_keys`,
] as const;

const family = (row: string) => `CASE WHEN COALESCE(${row}.proof_key_thumbprint, '') <> ''
  THEN json_array('proof', ${row}.proof_key_thumbprint, ${row}.subject, ${row}.method)
  ELSE json_array('session', ${row}.session_id) END`;
const affectedTargets = (id: string) =>
  `SELECT target_session_id FROM lastcode_thread_read_handoffs WHERE source_session_id = ${id} UNION SELECT ${id}`;
const affectedFamilies = (
  id: string,
) => `SELECT family_id FROM lastcode_thread_read_sessions WHERE session_id IN (${affectedTargets(id)})
  UNION SELECT family_id FROM lastcode_thread_read_handoffs WHERE target_session_id IN (${affectedTargets(id)}) OR source_session_id = ${id}`;
const key = (row: string) => `json_array('key', ${row}.proof_key_thumbprint)`;

// Bodies deliberately refer only to NEW/OLD and fork tables: upstream rebuilds can drop auth tables.
export const authorityTriggers = {
  lastcode_thread_read_session_insert: `CREATE TRIGGER IF NOT EXISTS lastcode_thread_read_session_insert
    AFTER INSERT ON auth_sessions BEGIN
    INSERT OR IGNORE INTO lastcode_thread_read_generations (id, generation)
      SELECT ${family("NEW")}, 0 WHERE NOT EXISTS
        (SELECT 1 FROM lastcode_thread_read_generation_keys WHERE id = ${family("NEW")});
    INSERT OR IGNORE INTO lastcode_thread_read_generations (id, generation)
      SELECT ${key("NEW")}, 0 WHERE COALESCE(NEW.proof_key_thumbprint, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM lastcode_thread_read_generation_keys WHERE id = ${key("NEW")});
    INSERT OR IGNORE INTO lastcode_thread_read_generation_keys (id) VALUES (${family("NEW")});
    INSERT OR IGNORE INTO lastcode_thread_read_generation_keys (id)
      SELECT ${key("NEW")} WHERE COALESCE(NEW.proof_key_thumbprint, '') <> '';
    INSERT OR IGNORE INTO lastcode_thread_read_sessions
      (session_id, proof_key, subject, method, scopes, family_id, key_generation, family_generation)
      SELECT NEW.session_id, NULLIF(NEW.proof_key_thumbprint, ''), NEW.subject, NEW.method, NEW.scopes,
        ${family("NEW")},
        (SELECT generation FROM lastcode_thread_read_generations WHERE id = ${key("NEW")}), generation
      FROM lastcode_thread_read_generations WHERE id = ${family("NEW")}
        AND (COALESCE(NEW.proof_key_thumbprint, '') = '' OR EXISTS
          (SELECT 1 FROM lastcode_thread_read_generations WHERE id = ${key("NEW")}));
    END`,
  lastcode_thread_read_session_revoke: `CREATE TRIGGER IF NOT EXISTS lastcode_thread_read_session_revoke
    AFTER UPDATE OF revoked_at ON auth_sessions
    WHEN NEW.revoked_at IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM lastcode_thread_read_handoff_exceptions WHERE source_session_id = OLD.session_id AND OLD.revoked_at IS NULL)
    BEGIN
    UPDATE lastcode_thread_read_generations SET generation = generation + 1, reason = 'revoked' WHERE id IN (${affectedFamilies("OLD.session_id")});
    INSERT OR IGNORE INTO lastcode_thread_read_failures (thread_id, kind, grant_id, reason, recorded_at)
      SELECT thread_id, kind, grant_id, 'reauth-required', last_used_at FROM lastcode_thread_read_grants WHERE family_id IN (${affectedFamilies("OLD.session_id")});
    DELETE FROM lastcode_thread_read_grants WHERE family_id IN (${affectedFamilies("OLD.session_id")});
    UPDATE lastcode_thread_read_handoffs SET invalidated = 1
      WHERE target_session_id IN (${affectedTargets("OLD.session_id")}) OR source_session_id = OLD.session_id;
    END`,
  lastcode_thread_read_device_delete: `CREATE TRIGGER IF NOT EXISTS lastcode_thread_read_device_delete
    AFTER DELETE ON auth_connect_devices BEGIN
    UPDATE lastcode_thread_read_generations SET generation = generation + 1, reason = 'revoked' WHERE id = ${key("OLD")};
    INSERT OR IGNORE INTO lastcode_thread_read_failures (thread_id, kind, grant_id, reason, recorded_at)
      SELECT thread_id, kind, grant_id, 'revoked', last_used_at FROM lastcode_thread_read_grants WHERE proof_key = OLD.proof_key_thumbprint;
    DELETE FROM lastcode_thread_read_grants WHERE proof_key = OLD.proof_key_thumbprint;
    UPDATE lastcode_thread_read_handoffs SET invalidated = 1 WHERE proof_key = OLD.proof_key_thumbprint;
    END`,
} as const;

const normalize = (definition: string) =>
  definition
    .replace(/^(\s*CREATE\s+TRIGGER\s+)IF\s+NOT\s+EXISTS\s+/i, "$1")
    .match(/'(?:''|[^'])*'|[^']+/g)!
    .map((part) => (part.startsWith("'") ? part : part.replace(/\s+/g, " ").toLowerCase()))
    .join("")
    .trim()
    .replace(/;$/, "");

const requiredColumns = {
  auth_sessions: [
    "session_id",
    "subject",
    "scopes",
    "method",
    "proof_key_thumbprint",
    "revoked_at",
    "expires_at",
  ],
  auth_connect_devices: ["proof_key_thumbprint", "approved_at"],
  lastcode_thread_read_failures: ["thread_id", "kind", "grant_id", "reason", "recorded_at"],
  lastcode_thread_read_generations: ["id", "generation", "reason"],
  lastcode_thread_read_generation_keys: ["id"],
  lastcode_thread_read_sessions: [
    "session_id",
    "proof_key",
    "subject",
    "method",
    "scopes",
    "family_id",
    "key_generation",
    "family_generation",
  ],
  lastcode_thread_read_grants: [
    "thread_id",
    "kind",
    "grant_id",
    "session_id",
    "proof_key",
    "subject",
    "method",
    "scopes",
    "family_id",
    "key_generation",
    "family_generation",
    "last_used_at",
  ],
  lastcode_thread_read_handoffs: [
    "source_session_id",
    "target_session_id",
    "family_id",
    "proof_key",
    "invalidated",
  ],
  lastcode_thread_read_handoff_exceptions: ["source_session_id", "target_session_id"],
} as const;

// Cache only verified schema versions, per SQL client (never per database filename).
const verified = new WeakMap<object, number>();
export const verifyAuthorityFence = Effect.fn("verifyThreadReadAuthorityFence")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const version = (yield* sql<{ schema_version: number }>`PRAGMA schema_version`)[0]!
    .schema_version;
  if (verified.get(sql) === version) return true;
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
    if (columns.some((column) => !actual.some((entry) => entry.name === column))) return false;
  }
  const actual = yield* sql<{
    name: string;
    sql: string;
  }>`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'lastcode_thread_read_%'`;
  if (
    Object.entries(authorityTriggers).some(
      ([name, definition]) =>
        !actual.some(
          (entry) => entry.name === name && normalize(entry.sql) === normalize(definition),
        ),
    )
  )
    return false;
  yield* sql.afterCommit(Effect.sync(() => verified.set(sql, version)));
  return true;
});

export const createAuthoritySchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE lastcode_thread_read_failures (thread_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('run', 'reference')), grant_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('reauth-required', 'revoked', 'expired', 'fence-unavailable')), recorded_at INTEGER NOT NULL, PRIMARY KEY (thread_id, kind, grant_id))`;
  yield* sql`CREATE INDEX lastcode_thread_read_failures_recency ON lastcode_thread_read_failures(recorded_at)`;
  // Keep allocated identities even if their counter/snapshot is lost; reauthentication cannot reset an epoch.
  yield* sql`CREATE TABLE lastcode_thread_read_generation_keys (id TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE lastcode_thread_read_generations (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT 'issued')`;
  yield* sql`CREATE TABLE lastcode_thread_read_sessions (
    session_id TEXT PRIMARY KEY, proof_key TEXT, subject TEXT NOT NULL, method TEXT NOT NULL,
    scopes TEXT NOT NULL, family_id TEXT NOT NULL, key_generation INTEGER, family_generation INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE lastcode_thread_read_grants (
    thread_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('run', 'reference')), grant_id TEXT NOT NULL,
    session_id TEXT NOT NULL, proof_key TEXT, subject TEXT NOT NULL, method TEXT NOT NULL, scopes TEXT NOT NULL,
    family_id TEXT NOT NULL, key_generation INTEGER, family_generation INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, kind, grant_id))`;
  yield* sql`CREATE INDEX lastcode_thread_read_grants_recency ON lastcode_thread_read_grants(last_used_at)`;
  yield* sql`CREATE INDEX lastcode_thread_read_grants_family ON lastcode_thread_read_grants(family_id)`;
  yield* sql`CREATE INDEX lastcode_thread_read_grants_key ON lastcode_thread_read_grants(proof_key)`;
  yield* sql`CREATE TABLE lastcode_thread_read_handoffs (
    source_session_id TEXT PRIMARY KEY, target_session_id TEXT NOT NULL, family_id TEXT NOT NULL,
    proof_key TEXT, invalidated INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE INDEX lastcode_thread_read_handoffs_target ON lastcode_thread_read_handoffs(target_session_id)`;
  yield* sql`CREATE TABLE lastcode_thread_read_handoff_exceptions (source_session_id TEXT PRIMARY KEY, target_session_id TEXT NOT NULL)`;
  yield* sql.unsafe(
    `INSERT INTO lastcode_thread_read_generations (id, generation) SELECT DISTINCT ${family("s")}, 0 FROM auth_sessions s`,
  ).unprepared;
  yield* sql.unsafe(
    `INSERT OR IGNORE INTO lastcode_thread_read_generations (id, generation) SELECT DISTINCT ${key("s")}, 0 FROM auth_sessions s WHERE COALESCE(s.proof_key_thumbprint, '') <> ''`,
  ).unprepared;
  yield* sql`INSERT INTO lastcode_thread_read_generation_keys SELECT id FROM lastcode_thread_read_generations`;
  yield* sql.unsafe(`INSERT INTO lastcode_thread_read_sessions SELECT session_id, NULLIF(proof_key_thumbprint, ''), subject, method, scopes,
    ${family("s")}, CASE WHEN COALESCE(proof_key_thumbprint, '') <> '' THEN 0 ELSE NULL END, 0 FROM auth_sessions s`)
    .unprepared;
  for (const definition of Object.values(authorityTriggers))
    yield* sql.unsafe(definition).unprepared;
});

/** Call only under migration ownership, after both ledgers. Missing evidence is never backfilled. */
export const reconcileAuthorityFence = Effect.fn("reconcileThreadReadAuthorityFence")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* verifyAuthorityFence()) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT OR IGNORE INTO lastcode_thread_read_failures (thread_id, kind, grant_id, reason, recorded_at)
      SELECT thread_id, kind, grant_id, 'reauth-required', last_used_at FROM lastcode_thread_read_grants`;
      yield* sql`DELETE FROM lastcode_thread_read_grants`;
      yield* sql`UPDATE lastcode_thread_read_generations SET generation = generation + 1, reason = 'fence-repaired'`;
      yield* sql`UPDATE lastcode_thread_read_handoffs SET invalidated = 1`;
      for (const [name, definition] of Object.entries(authorityTriggers)) {
        yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${name}`).unprepared;
        yield* sql.unsafe(definition).unprepared;
      }
      if (!(yield* verifyAuthorityFence()))
        return yield* Effect.die("Thread read authority schema cannot be verified");
    }),
  );
});
