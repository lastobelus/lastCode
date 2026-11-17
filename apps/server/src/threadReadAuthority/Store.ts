import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";
import { verifyAuthorityFence } from "./Schema.ts";
import type {
  AuthorityFailureReason,
  AuthorityLease,
  GrantCheck,
  SessionAuthority,
  ThreadReadGrant,
} from "./Types.ts";

export const grantIdleMillis = 7 * 24 * 60 * 60 * 1000;
export const maxGrantRows = 10_000;
interface IdentityRow {
  session_id: string;
  proof_key: string | null;
  subject: string;
  method: string;
  scopes: string;
  family_id: string;
  key_generation: number | null;
  family_generation: number;
}
interface SessionRow extends IdentityRow {
  revoked_at: string | null;
  expires_at: string;
}
interface GrantRow extends IdentityRow {
  thread_id: string;
  kind: "run" | "reference";
  grant_id: string;
  last_used_at: number;
}
const identity = (row: IdentityRow): SessionAuthority =>
  Object.freeze({
    sessionId: row.session_id,
    proofKey: row.proof_key,
    subject: row.subject,
    method: row.method,
    scopes: Object.freeze(JSON.parse(row.scopes) as string[]),
    familyId: row.family_id,
    keyGeneration: row.key_generation,
    familyGeneration: row.family_generation,
  });
const encode = (value: ReadonlyArray<string | null>) => JSON.stringify(value);
const contains = (scopes: ReadonlyArray<string>, ceiling: ReadonlyArray<string>) =>
  ceiling.every((scope) => scopes.includes(scope));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fence = () => verifyAuthorityFence().pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const session = (id: string) => sql<SessionRow>`SELECT p.*, a.revoked_at, a.expires_at
    FROM lastcode_thread_read_sessions p JOIN auth_sessions a ON a.session_id = p.session_id
    WHERE p.session_id = ${id} AND p.subject = a.subject AND p.method = a.method
      AND p.scopes = a.scopes AND p.proof_key IS NULLIF(a.proof_key_thumbprint, '')`;
  const generationValid = Effect.fn("threadReadAuthority.generationValid")(function* (
    authority: SessionAuthority,
  ) {
    if (!(yield* fence())) return false;
    const [family] = yield* sql<{
      generation: number;
    }>`SELECT generation FROM lastcode_thread_read_generations WHERE id = ${authority.familyId}`;
    if (family?.generation !== authority.familyGeneration) return false;
    if (authority.proofKey !== null) {
      const [key] = yield* sql<{
        generation: number;
      }>`SELECT generation FROM lastcode_thread_read_generations WHERE id = ${encode(["key", authority.proofKey])}`;
      if (key?.generation !== authority.keyGeneration) return false;
    }
    return true;
  });
  const approvalValid = (authority: SessionAuthority) =>
    authority.proofKey !== null && authority.subject === "cloud-connect"
      ? sql`SELECT 1 FROM auth_connect_devices WHERE proof_key_thumbprint = ${authority.proofKey}`.pipe(
          Effect.map((rows) => rows.length > 0),
        )
      : Effect.succeed(true);
  const rowCurrent = (row: SessionRow, now: number, live: boolean) =>
    row.revoked_at === null && (live || Date.parse(row.expires_at) > now);
  const captureAuthenticatedSessionAuthority = Effect.fn("threadReadAuthority.capture")(function* (
    sessionId: string,
    lease: AuthorityLease = {},
  ) {
    if (!(yield* fence())) return undefined;
    const [row] = yield* session(sessionId);
    const now = lease.now ?? (yield* Clock.currentTimeMillis);
    const live =
      lease.isLive?.() === true || lease.connectedSessionIds?.includes(sessionId) === true;
    if (!row || !rowCurrent(row, now, live)) return undefined;
    const captured = identity(row);
    if (!(yield* generationValid(captured)) || !(yield* approvalValid(captured))) return undefined;
    return Object.freeze({ ...captured, ...(lease.isLive ? { liveLease: lease.isLive } : {}) });
  });
  const resolveOwner = Effect.fn("threadReadAuthority.resolveOwner")(function* (
    authority: SessionAuthority,
  ) {
    const [handoff] = yield* sql<{
      target_session_id: string;
    }>`SELECT h.target_session_id FROM lastcode_thread_read_handoffs h
      JOIN lastcode_thread_read_sessions p ON p.session_id = h.source_session_id
        AND p.family_id = h.family_id AND p.proof_key IS h.proof_key
      WHERE h.source_session_id = ${authority.sessionId} AND h.invalidated = 0
        AND p.proof_key IS ${authority.proofKey} AND p.subject = ${authority.subject} AND p.method = ${authority.method}`;
    return handoff?.target_session_id ?? authority.sessionId;
  });
  const grantSource = Effect.fn("threadReadAuthority.source")(function* (
    grant: ThreadReadGrant,
    now: number,
    liveIds: ReadonlyArray<string>,
  ): Effect.fn.Return<
    | { readonly status: "current"; readonly sessionId: string }
    | { readonly status: AuthorityFailureReason },
    SqlError.SqlError
  > {
    if (!(yield* fence())) return { status: "fence-unavailable" };
    if (grant.lastUsedAt <= now - grantIdleMillis) return { status: "expired" };
    if (!(yield* approvalValid(grant))) return { status: "revoked" };
    if (!(yield* generationValid(grant))) return { status: "reauth-required" };
    const owner = yield* resolveOwner(grant);
    const [source] = yield* session(owner);
    if (!source || source.revoked_at !== null) return { status: "revoked" };
    const target = identity(source);
    if (
      !(yield* generationValid(target)) ||
      target.proofKey !== grant.proofKey ||
      target.subject !== grant.subject ||
      target.method !== grant.method ||
      !contains(target.scopes, grant.scopes)
    )
      return { status: "revoked" };
    if (
      !rowCurrent(source, now, liveIds.includes(owner)) &&
      !(grant.proofKey !== null && grant.subject === "cloud-connect")
    )
      return { status: "expired" };
    return { status: "current", sessionId: owner };
  });
  const authorityCurrent = Effect.fn("threadReadAuthority.current")(function* (
    authority: SessionAuthority,
    now: number,
    liveIds: ReadonlyArray<string> = [],
  ) {
    if (!(yield* generationValid(authority)) || !(yield* approvalValid(authority))) return false;
    if (authority.inheritedGrant !== undefined) {
      const point = authority.inheritedGrant;
      const retained = yield* lookupGrant(point.threadId, point.kind, point.grantId);
      if (
        point.lastUsedAt <= now - grantIdleMillis ||
        !retained ||
        retained.familyId !== authority.familyId ||
        retained.familyGeneration !== authority.familyGeneration ||
        retained.keyGeneration !== authority.keyGeneration ||
        retained.proofKey !== authority.proofKey ||
        retained.subject !== authority.subject ||
        retained.method !== authority.method ||
        encode(retained.scopes) !== encode(authority.scopes) ||
        (yield* resolveOwner(retained)) !== (yield* resolveOwner(authority))
      )
        return false;
      return (
        (yield* grantSource(retained, now, authority.liveSessionIds?.() ?? [])).status === "current"
      );
    }
    const owner = yield* resolveOwner(authority);
    const [row] = yield* session(owner);
    if (
      !row ||
      !rowCurrent(
        row,
        now,
        liveIds.includes(owner) ||
          (owner === authority.sessionId && authority.liveLease?.() === true),
      )
    )
      return false;
    const target = identity(row);
    return (
      target.subject === authority.subject &&
      target.method === authority.method &&
      target.proofKey === authority.proofKey &&
      contains(target.scopes, authority.scopes) &&
      (yield* generationValid(target))
    );
  });
  const lookupGrant = Effect.fn("threadReadAuthority.lookup")(function* (
    threadId: ThreadId,
    kind: "run" | "reference",
    grantId: string,
  ) {
    if (!(yield* fence())) return undefined;
    const [row] =
      yield* sql<GrantRow>`SELECT * FROM lastcode_thread_read_grants WHERE thread_id = ${threadId} AND kind = ${kind} AND grant_id = ${grantId}`;
    if (!row) return undefined;
    return Object.freeze({
      ...identity(row),
      threadId,
      kind,
      grantId,
      lastUsedAt: row.last_used_at,
    });
  });
  const lookupFailureReason = Effect.fn("threadReadAuthority.lookupFailure")(function* (
    threadId: ThreadId,
    kind: "run" | "reference",
    grantId: string,
  ) {
    if (!(yield* fence())) return "fence-unavailable" as const;
    const [row] = yield* sql<{
      reason: AuthorityFailureReason;
    }>`SELECT reason FROM lastcode_thread_read_failures
      WHERE thread_id = ${threadId} AND kind = ${kind} AND grant_id = ${grantId} AND recorded_at > ${(yield* Clock.currentTimeMillis) - grantIdleMillis}`;
    return row?.reason;
  });
  const recordFailure = (
    threadId: ThreadId,
    kind: "run" | "reference",
    grantId: string,
    reason: AuthorityFailureReason,
    now: number,
  ) =>
    sql`INSERT INTO lastcode_thread_read_failures (thread_id, kind, grant_id, reason, recorded_at)
      VALUES (${threadId}, ${kind}, ${grantId}, ${reason}, ${now}) ON CONFLICT(thread_id, kind, grant_id) DO NOTHING`;
  const admissionFailureReason = Effect.fn("threadReadAuthority.admissionFailure")(function* (
    authority: SessionAuthority,
  ) {
    if (!(yield* fence())) return "fence-unavailable" as const;
    if (!(yield* generationValid(authority))) return "reauth-required" as const;
    if (!(yield* approvalValid(authority))) return "revoked" as const;
    return "expired" as const;
  });
  const bindGrant = Effect.fn("threadReadAuthority.bind")(function* (
    threadId: ThreadId,
    kind: "run" | "reference",
    grantId: string,
    authority: SessionAuthority,
    now: number,
  ) {
    if (!(yield* fence()) || !(yield* authorityCurrent(authority, now))) return false;
    const owner = yield* resolveOwner(authority);
    const lastUsedAt = authority.inheritedGrant?.lastUsedAt ?? now;
    yield* sql`INSERT INTO lastcode_thread_read_grants
      (thread_id, kind, grant_id, session_id, proof_key, subject, method, scopes, family_id, key_generation, family_generation, last_used_at)
      VALUES (${threadId}, ${kind}, ${grantId}, ${owner}, ${authority.proofKey}, ${authority.subject}, ${authority.method}, ${encode(authority.scopes)}, ${authority.familyId}, ${authority.keyGeneration}, ${authority.familyGeneration}, ${lastUsedAt})
      ON CONFLICT(thread_id, kind, grant_id) DO NOTHING`;
    const existing = yield* lookupGrant(threadId, kind, grantId);
    return (
      existing !== undefined &&
      existing.sessionId === owner &&
      existing.familyId === authority.familyId &&
      existing.familyGeneration === authority.familyGeneration &&
      existing.keyGeneration === authority.keyGeneration &&
      existing.subject === authority.subject &&
      existing.method === authority.method &&
      existing.proofKey === authority.proofKey &&
      encode(existing.scopes) === encode(authority.scopes)
    );
  });
  const eligibleConnectedSessions = Effect.fn("threadReadAuthority.eligible")(function* (
    grant: ThreadReadGrant,
    connectedSessionIds: ReadonlyArray<string>,
  ): Effect.fn.Return<GrantCheck, SqlError.SqlError> {
    const source = yield* grantSource(grant, yield* Clock.currentTimeMillis, connectedSessionIds);
    if (source.status !== "current") return source;
    const owner = source.sessionId;
    const eligible: string[] = [];
    for (const id of new Set(connectedSessionIds)) {
      const [row] = yield* session(id);
      if (!row || row.revoked_at !== null) continue;
      const target = identity(row);
      if (!(yield* generationValid(target)) || !contains(target.scopes, grant.scopes)) continue;
      if (
        id === owner ||
        (grant.proofKey !== null &&
          grant.subject === "cloud-connect" &&
          target.proofKey === grant.proofKey &&
          target.subject === grant.subject &&
          target.method === grant.method &&
          target.familyGeneration === grant.familyGeneration &&
          target.keyGeneration === grant.keyGeneration)
      )
        eligible.push(id);
    }
    return eligible.length > 0
      ? { status: "eligible", sessionIds: eligible }
      : { status: "disconnected" };
  });
  const prepareInheritedAuthority = Effect.fn("threadReadAuthority.inherit")(function* (
    grant: ThreadReadGrant,
    connectedSessionIds: () => ReadonlyArray<string>,
    isLive: (sessionId: string) => boolean,
  ) {
    const captured = Object.freeze({
      ...grant,
      inheritedGrant: Object.freeze({
        threadId: grant.threadId,
        kind: grant.kind,
        grantId: grant.grantId,
        lastUsedAt: grant.lastUsedAt,
      }),
      liveSessionIds: () => connectedSessionIds().filter(isLive),
    }) satisfies SessionAuthority;
    return (yield* authorityCurrent(captured, yield* Clock.currentTimeMillis))
      ? captured
      : undefined;
  });
  const sessionAuthorityStatus = Effect.fn("threadReadAuthority.sessionStatus")(function* (
    sessionId: string,
  ) {
    if (!(yield* fence())) return "fence-unavailable" as const;
    const [row] = yield* session(sessionId);
    if (!row) {
      const present = yield* sql`SELECT 1 FROM auth_sessions WHERE session_id = ${sessionId}`;
      return present.length > 0 ? ("reauth-required" as const) : ("unavailable" as const);
    }
    if (yield* generationValid(identity(row)))
      return row.revoked_at === null ? ("current" as const) : ("revoked" as const);
    return "reauth-required" as const;
  });
  const touchSuccessfulRead = Effect.fn("threadReadAuthority.touch")(function* (
    grant: ThreadReadGrant,
    connectedSessionId: string,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const retained = yield* lookupGrant(grant.threadId, grant.kind, grant.grantId);
        if (
          !retained ||
          retained.familyId !== grant.familyId ||
          retained.familyGeneration !== grant.familyGeneration ||
          retained.keyGeneration !== grant.keyGeneration ||
          retained.proofKey !== grant.proofKey ||
          retained.subject !== grant.subject ||
          retained.method !== grant.method ||
          encode(retained.scopes) !== encode(grant.scopes) ||
          (yield* resolveOwner(retained)) !== (yield* resolveOwner(grant))
        )
          return false;
        const check = yield* eligibleConnectedSessions(retained, [connectedSessionId]);
        if (check.status !== "eligible") return false;
        const now = yield* Clock.currentTimeMillis;
        if (retained.lastUsedAt <= now - grantIdleMillis) return false;
        if (retained.lastUsedAt > now - 60_000) return true;
        const updated = yield* sql`UPDATE lastcode_thread_read_grants SET last_used_at = ${now}
          WHERE thread_id = ${retained.threadId} AND kind = ${retained.kind} AND grant_id = ${retained.grantId}
            AND last_used_at = ${retained.lastUsedAt}
          RETURNING 1`;
        return updated.length > 0;
      }),
    );
  });
  const prune = Effect.fn("threadReadAuthority.prune")(function* (now: number) {
    yield* sql`DELETE FROM lastcode_thread_read_failures WHERE recorded_at <= ${now - grantIdleMillis}`;
    yield* sql`DELETE FROM lastcode_thread_read_failures WHERE rowid IN
      (SELECT rowid FROM lastcode_thread_read_failures ORDER BY recorded_at DESC, rowid DESC LIMIT -1 OFFSET ${maxGrantRows})`;
    yield* sql`DELETE FROM lastcode_thread_read_grants WHERE last_used_at <= ${now - grantIdleMillis}`;
    yield* sql`DELETE FROM lastcode_thread_read_grants WHERE rowid IN
      (SELECT rowid FROM lastcode_thread_read_grants ORDER BY last_used_at DESC, rowid DESC LIMIT -1 OFFSET ${maxGrantRows})`;
  });
  return {
    captureAuthenticatedSessionAuthority,
    prepareInheritedAuthority,
    sessionAuthorityStatus,
    lookupFailureReason,
    recordFailure,
    admissionFailureReason,
    lookupGrant,
    eligibleConnectedSessions,
    generationValid,
    touchSuccessfulRead,
    bindGrant,
    prune,
    authorityCurrent,
  };
});
export type ThreadReadAuthorityStore = Effect.Success<typeof make>;
