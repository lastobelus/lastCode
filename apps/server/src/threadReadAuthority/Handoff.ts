import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { CreateAuthSessionInput } from "../persistence/AuthSessions.ts";
import { verifyAuthorityFence } from "./Schema.ts";

const scopesFit = (encoded: string, scopes: ReadonlyArray<string>) =>
  (JSON.parse(encoded) as string[]).every((scope) => scopes.includes(scope));

/** Must run within the replacement transaction, before any source is stamped revoked. */
export const prepareHandoff = Effect.fn("threadReadAuthority.prepareHandoff")(function* (
  sourceSessionIds: ReadonlyArray<string>,
  target: CreateAuthSessionInput,
) {
  const sql = yield* SqlClient.SqlClient;
  if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
    return yield* Effect.die("Thread read handoff requires the issuing transaction");
  if (!(yield* verifyAuthorityFence()))
    return yield* Effect.die("Thread read authority fence is unavailable during replacement");
  const compatible: string[] = [];
  for (const sourceId of sourceSessionIds) {
    const [source] = yield* sql<{
      session_id: string;
      proof_key: string | null;
      subject: string;
      method: string;
      scopes: string;
      family_id: string;
      key_generation: number | null;
      family_generation: number;
    }>`SELECT p.* FROM lastcode_thread_read_sessions p JOIN auth_sessions a ON a.session_id = p.session_id
      JOIN lastcode_thread_read_generations g ON g.id = p.family_id AND g.generation = p.family_generation
      WHERE p.session_id = ${sourceId} AND a.revoked_at IS NULL
        AND p.subject = a.subject AND p.method = a.method AND p.scopes = a.scopes
        AND p.proof_key IS NULLIF(a.proof_key_thumbprint, '')
        AND (p.proof_key IS NULL OR EXISTS (SELECT 1 FROM lastcode_thread_read_generations k
          WHERE k.id = json_array('key', p.proof_key) AND k.generation = p.key_generation))`;
    if (
      !source ||
      source.subject !== target.subject ||
      source.method !== target.method ||
      source.proof_key !== (target.proofKeyThumbprint || null) ||
      !scopesFit(source.scopes, target.scopes)
    )
      continue;
    yield* sql`INSERT INTO lastcode_thread_read_handoff_exceptions (source_session_id, target_session_id) VALUES (${sourceId}, ${target.sessionId})`;
    compatible.push(sourceId);
  }
  return compatible;
});

/** The target row exists and source stamps are complete; all writes still share that transaction. */
export const finishHandoff = Effect.fn("threadReadAuthority.finishHandoff")(function* (
  sourceSessionIds: ReadonlyArray<string>,
  targetSessionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
    return yield* Effect.die("Thread read handoff requires the issuing transaction");
  for (const sourceId of sourceSessionIds) {
    yield* sql`UPDATE lastcode_thread_read_handoffs SET target_session_id = ${targetSessionId}
      WHERE target_session_id = ${sourceId} AND invalidated = 0`;
    yield* sql`INSERT INTO lastcode_thread_read_handoffs
      (source_session_id, target_session_id, family_id, proof_key, invalidated)
      SELECT session_id, ${targetSessionId}, family_id, proof_key, 0 FROM lastcode_thread_read_sessions
      WHERE session_id = ${sourceId}`;
    yield* sql`UPDATE lastcode_thread_read_grants SET session_id = ${targetSessionId} WHERE session_id = ${sourceId}`;
    yield* sql`DELETE FROM lastcode_thread_read_handoff_exceptions WHERE source_session_id = ${sourceId}`;
  }
});

/** Also runs for already-revoked/removed historical source rows whose UPDATE returns no rows. */
export const invalidateHistoricalSources = Effect.fn(
  "threadReadAuthority.invalidateHistoricalSources",
)(function* (sessionIds: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  for (const sessionId of sessionIds) {
    const targets = sql`SELECT target_session_id FROM lastcode_thread_read_handoffs WHERE source_session_id = ${sessionId} UNION SELECT ${sessionId}`;
    const families = sql`SELECT family_id FROM lastcode_thread_read_sessions WHERE session_id IN (${targets})
      UNION SELECT family_id FROM lastcode_thread_read_handoffs WHERE target_session_id IN (${targets}) OR source_session_id = ${sessionId}`;
    yield* sql`UPDATE lastcode_thread_read_generations SET generation = generation + 1, reason = 'revoked' WHERE id IN (${families})`;
    yield* sql`INSERT OR IGNORE INTO lastcode_thread_read_failures (thread_id, kind, grant_id, reason, recorded_at)
      SELECT thread_id, kind, grant_id, 'reauth-required', last_used_at FROM lastcode_thread_read_grants WHERE family_id IN (${families})`;
    yield* sql`DELETE FROM lastcode_thread_read_grants WHERE family_id IN (${families})`;
    yield* sql`UPDATE lastcode_thread_read_handoffs SET invalidated = 1 WHERE source_session_id = ${sessionId} OR target_session_id = ${sessionId}
      OR target_session_id IN (SELECT target_session_id FROM lastcode_thread_read_handoffs WHERE source_session_id = ${sessionId})`;
  }
});
