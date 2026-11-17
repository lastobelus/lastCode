import { assert, it } from "@effect/vitest";
import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { runDatabaseMigrations } from "../persistence/DatabaseMigrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { authorityTables, authorityTriggers, verifyAuthorityFence } from "./Schema.ts";
import * as Store from "./Store.ts";

const threadId = ThreadId.make("authority-thread");
const layer = AuthSessions.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const insert = Effect.fn("insertAuthoritySession")(function* (
  id: string,
  options: {
    key?: string;
    subject?: string;
    method?: AuthSessions.CreateAuthSessionInput["method"];
    scopes?: AuthSessions.CreateAuthSessionInput["scopes"];
    expires?: number;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const session: AuthSessions.CreateAuthSessionInput = {
    sessionId: AuthSessionId.make(id),
    subject: options.subject ?? "cloud-connect",
    method: options.method ?? "dpop-access-token",
    scopes: options.scopes ?? ["orchestration:read"],
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
    issuedAt: now,
    expiresAt: DateTime.makeUnsafe(
      (yield* Clock.currentTimeMillis) + (options.expires ?? 3_600_000),
    ),
    ...(options.key === undefined ? {} : { proofKeyThumbprint: options.key }),
  };
  if (options.key)
    yield* sql`INSERT OR IGNORE INTO auth_connect_devices(proof_key_thumbprint, approved_at) VALUES (${options.key}, ${DateTime.formatIso(now)})`;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  yield* sessions.create(session);
  return session;
});
const bind = Effect.fn("bindAuthorityFixture")(function* (
  id: string,
  grantId = "run",
  live = () => true,
) {
  const store = yield* Store.make;
  const authority = yield* store.captureAuthenticatedSessionAuthority(id, { isLive: live });
  assert.isDefined(authority);
  assert.isTrue(
    yield* store.bindGrant(threadId, "run", grantId, authority!, yield* Clock.currentTimeMillis),
  );
  return {
    store,
    authority: authority!,
    grant: (yield* store.lookupGrant(threadId, "run", grantId))!,
  };
});

it.effect.each(["grant-first", "revoke-first"] as const)(
  "serializes %s with device removal/reapproval in the same tick",
  (order) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert("old", { key: "key" });
      const store = yield* Store.make;
      const captured = (yield* store.captureAuthenticatedSessionAuthority("old", {
        isLive: () => true,
      }))!;
      if (order === "grant-first")
        assert.isTrue(
          yield* sql.withTransaction(store.bindGrant(threadId, "run", "run", captured, 0)),
        );
      yield* sql`DELETE FROM auth_connect_devices WHERE proof_key_thumbprint = 'key'`;
      // Approval remains removed even if subsequent token cleanup rolls back.
      yield* sql
        .withTransaction(
          sql`UPDATE auth_sessions SET revoked_at = 'failed-cleanup'`.pipe(
            Effect.andThen(Effect.fail("cleanup")),
          ),
        )
        .pipe(Effect.flip);
      yield* sql`INSERT INTO auth_connect_devices(proof_key_thumbprint, approved_at) VALUES ('key', 'same-tick')`;
      assert.isFalse(yield* store.bindGrant(threadId, "run", "delayed", captured, 0));
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
      assert.isUndefined(
        yield* store.captureAuthenticatedSessionAuthority("old", { isLive: () => true }),
      );
      yield* insert("new", { key: "key" });
      const next = (yield* store.captureAuthenticatedSessionAuthority("new"))!;
      assert.equal(next.keyGeneration, captured.keyGeneration! + 1);
      assert.isTrue(yield* store.bindGrant(threadId, "run", "fresh", next, 0));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "allows approved Connect sleep/reconnect but never a custom OAuth key, narrower scopes or a different subject",
  () =>
    Effect.gen(function* () {
      yield* insert("original", { key: "key", scopes: ["orchestration:read", "filesystem:read"] });
      const { store, grant } = yield* bind("original");
      yield* TestClock.adjust("2 hours");
      yield* insert("successor", { key: "key", scopes: ["orchestration:read", "filesystem:read"] });
      yield* insert("narrow", { key: "key" });
      yield* insert("custom", {
        key: "key",
        subject: "custom-oauth",
        scopes: ["orchestration:read", "filesystem:read"],
      });
      yield* insert("wrong-method", {
        key: "key",
        method: "bearer-access-token",
        scopes: ["orchestration:read", "filesystem:read"],
      });
      assert.deepEqual(
        yield* store.eligibleConnectedSessions(grant, [
          "successor",
          "narrow",
          "custom",
          "wrong-method",
        ]),
        { status: "eligible", sessionIds: ["successor"] },
      );
      const inherited = (yield* store.prepareInheritedAuthority(
        grant,
        () => ["successor"],
        () => true,
      ))!;
      assert.equal(inherited.familyGeneration, grant.familyGeneration);
      assert.isTrue(
        yield* store.bindGrant(threadId, "run", "wake", inherited, yield* Clock.currentTimeMillis),
      );
      yield* insert("custom-1", { key: "custom-key", subject: "custom-oauth" });
      const custom = yield* bind("custom-1", "custom-run");
      yield* insert("custom-2", { key: "custom-key", subject: "custom-oauth" });
      assert.deepEqual(yield* store.eligibleConnectedSessions(custom.grant, ["custom-2"]), {
        status: "disconnected",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps original supervised socket scopes after row expiry, then refuses revoked sockets and inherited intents",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert("socket", { key: "key" });
      const { store, grant, authority } = yield* bind("socket");
      yield* TestClock.adjust("2 hours");
      assert.isDefined(
        yield* store.captureAuthenticatedSessionAuthority("socket", { isLive: () => true }),
      );
      assert.isUndefined(yield* store.captureAuthenticatedSessionAuthority("socket"));
      assert.isTrue(
        yield* store.bindGrant(
          threadId,
          "run",
          "expired-but-supervised",
          authority,
          yield* Clock.currentTimeMillis,
        ),
      );
      assert.deepEqual(yield* store.eligibleConnectedSessions(grant, ["socket"]), {
        status: "eligible",
        sessionIds: ["socket"],
      });
      const inherited = (yield* store.prepareInheritedAuthority(
        grant,
        () => ["socket"],
        () => true,
      ))!;
      yield* insert("later", { key: "key" });
      yield* sql`UPDATE auth_sessions SET revoked_at = 'revoked' WHERE session_id = 'later'`;
      assert.isFalse(
        yield* store.bindGrant(
          threadId,
          "run",
          "stale-direct",
          authority,
          yield* Clock.currentTimeMillis,
        ),
      );
      assert.isFalse(
        yield* store.bindGrant(
          threadId,
          "run",
          "stale-inherit",
          inherited,
          yield* Clock.currentTimeMillis,
        ),
      );
      assert.equal(yield* store.sessionAuthorityStatus("socket"), "reauth-required");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "makes compatible replacement atomic, flattens its pointers, and invalidates a zero-row historical revoke",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const original = yield* insert("cookie", {
        subject: "paired",
        method: "browser-session-cookie",
      });
      const { store, grant, authority } = yield* bind("cookie");
      const replacement = { ...original, sessionId: AuthSessionId.make("replacement") };
      yield* sessions.createReplacingActive({
        session: replacement,
        revokedAt: original.issuedAt,
        replaceSessionId: original.sessionId,
      });
      const latest = { ...replacement, sessionId: AuthSessionId.make("latest") };
      yield* sessions.createReplacingActive({
        session: latest,
        revokedAt: original.issuedAt,
        replaceSessionId: replacement.sessionId,
      });
      assert.deepEqual(
        yield* sql<{
          target_session_id: string;
        }>`SELECT target_session_id FROM lastcode_thread_read_handoffs`,
        [{ target_session_id: "latest" }, { target_session_id: "latest" }],
      );
      assert.deepEqual(yield* store.eligibleConnectedSessions(grant, ["latest"]), {
        status: "eligible",
        sessionIds: ["latest"],
      });
      assert.isTrue(yield* store.bindGrant(threadId, "run", "pending", authority, 0));
      assert.isFalse(
        yield* sessions.revoke({ sessionId: original.sessionId, revokedAt: original.issuedAt }),
      );
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
      assert.isFalse(yield* store.bindGrant(threadId, "run", "too-late", authority, 0));
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_handoff_exceptions`, []);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "does not transfer an incompatible replacement and rolls all stamps back if private SQL fails",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const original = yield* insert("desktop", {
        subject: "desktop",
        method: "bearer-access-token",
        scopes: ["orchestration:read", "filesystem:read"],
      });
      const { store } = yield* bind("desktop");
      const incompatible = {
        ...original,
        sessionId: AuthSessionId.make("narrow"),
        scopes: ["orchestration:read"] as const,
      };
      yield* sessions.createReplacingActive({
        session: incompatible,
        revokedAt: original.issuedAt,
      });
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
      yield* bind("narrow", "narrow-grant");
      yield* sql`CREATE TRIGGER fail_handoff BEFORE INSERT ON lastcode_thread_read_handoffs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      yield* sessions
        .createReplacingActive({
          session: { ...incompatible, sessionId: AuthSessionId.make("failed") },
          revokedAt: original.issuedAt,
        })
        .pipe(Effect.flip);
      const [prior] = yield* sql<{
        revoked_at: string | null;
      }>`SELECT revoked_at FROM auth_sessions WHERE session_id = 'narrow'`;
      assert.isNull(prior!.revoked_at);
      assert.isDefined(yield* store.captureAuthenticatedSessionAuthority("narrow"));
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_handoff_exceptions`, []);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["dpop", "cookie", "desktop"] as const)(
  "applies revoke-others to %s authority without re-revoking verified replacements",
  (mode) =>
    Effect.gen(function* () {
      const original = yield* insert(
        "old",
        mode === "dpop"
          ? { key: "key" }
          : {
              subject: mode,
              method: mode === "cookie" ? "browser-session-cookie" : "bearer-access-token",
            },
      );
      const { store, authority, grant } = yield* bind("old");
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const newer =
        mode === "dpop"
          ? yield* insert("new", { key: "key" })
          : { ...original, sessionId: AuthSessionId.make("new") };
      if (mode !== "dpop") {
        yield* sessions.createReplacingActive({
          session: newer,
          replaceSessionId: original.sessionId,
          revokedAt: original.issuedAt,
        });
      }
      yield* sessions.revokeAllExcept({
        currentSessionId: newer.sessionId,
        revokedAt: newer.issuedAt,
      });
      if (mode === "dpop") {
        assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
        assert.isUndefined(
          yield* store.captureAuthenticatedSessionAuthority("new", { isLive: () => true }),
        );
        assert.isFalse(yield* store.bindGrant(threadId, "run", "stale", authority, 0));
      } else {
        assert.isDefined(yield* store.lookupGrant(threadId, "run", "run"));
        assert.deepEqual(yield* store.eligibleConnectedSessions(grant, ["new"]), {
          status: "eligible",
          sessionIds: ["new"],
        });
        assert.isDefined(yield* store.captureAuthenticatedSessionAuthority("new"));
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "repairs upstream-style rebuilds after both ledgers, preserving snapshots and counters while requiring reauthentication",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert("before", { key: "key" });
      const { store, authority, grant } = yield* bind("before");
      const snapshots = yield* sql`SELECT * FROM lastcode_thread_read_sessions`;
      for (const table of ["auth_sessions", "auth_connect_devices"]) {
        const [definition] = yield* sql<{
          sql: string;
        }>`SELECT sql FROM sqlite_master WHERE name = ${table}`;
        yield* sql.unsafe(definition!.sql.replace(table, `${table}_new`)).unprepared;
        yield* sql.unsafe(`INSERT INTO ${table}_new SELECT * FROM ${table}`).unprepared;
        yield* sql.unsafe(`DROP TABLE ${table}`).unprepared;
        yield* sql.unsafe(`ALTER TABLE ${table}_new RENAME TO ${table}`).unprepared;
      }
      assert.isFalse(yield* verifyAuthorityFence());
      assert.deepEqual(yield* store.eligibleConnectedSessions(grant, ["before"]), {
        status: "fence-unavailable",
      });
      assert.isFalse(yield* store.bindGrant(threadId, "run", "missing-fence", authority, 0));
      assert.deepEqual(yield* runDatabaseMigrations(), []);
      assert.isTrue(yield* verifyAuthorityFence());
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_sessions`, snapshots);
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
      assert.equal(yield* store.sessionAuthorityStatus("before"), "reauth-required");
      assert.isUndefined(
        yield* store.captureAuthenticatedSessionAuthority("before", { isLive: () => true }),
      );
      yield* insert("after", { key: "key" });
      const fresh = yield* bind("after", "fresh");
      assert.equal(fresh.authority.keyGeneration, authority.keyGeneration! + 1);
      yield* sql`UPDATE auth_sessions SET revoked_at = 'revoked' WHERE session_id = 'after'`;
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "fresh"));
      // Trigger bodies cannot couple upstream table lifetimes to each other.
      for (const definition of Object.values(authorityTriggers)) {
        const body = definition.slice(definition.indexOf("BEGIN"));
        assert.notInclude(body, "FROM auth_");
        assert.notInclude(body, "INTO auth_");
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "repairs definition drift, never resets missing generation evidence, and rolls repair SQL back",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert("session", { key: "key" });
      const { store, authority } = yield* bind("session");
      yield* sql`DELETE FROM lastcode_thread_read_generations WHERE id = ${authority.familyId}`;
      yield* sql`DELETE FROM lastcode_thread_read_sessions WHERE session_id = 'session'`;
      yield* insert("same-family", { key: "key" });
      assert.isUndefined(yield* store.captureAuthenticatedSessionAuthority("same-family"));
      assert.isUndefined(yield* store.captureAuthenticatedSessionAuthority("session"));
      yield* sql`DROP TRIGGER lastcode_thread_read_device_delete`;
      yield* sql`CREATE TRIGGER lastcode_thread_read_device_delete AFTER DELETE ON auth_connect_devices BEGIN SELECT 1; END`;
      const generations = yield* sql`SELECT * FROM lastcode_thread_read_generations`;
      yield* sql`CREATE TRIGGER fail_repair BEFORE DELETE ON lastcode_thread_read_grants BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      yield* runDatabaseMigrations().pipe(Effect.flip);
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_generations`, generations);
      assert.isFalse(yield* verifyAuthorityFence());
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "refreshes only successful reads at one-minute granularity, enforces idle retention, and clears all QA authority",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert("session", { key: "key" });
      const { store, grant } = yield* bind("session");
      yield* TestClock.adjust("30 seconds");
      assert.isFalse(yield* store.touchSuccessfulRead(grant, "other"));
      assert.isTrue(yield* store.touchSuccessfulRead(grant, "session"));
      assert.equal((yield* store.lookupGrant(threadId, "run", "run"))!.lastUsedAt, 0);
      yield* TestClock.adjust("31 seconds");
      assert.isTrue(yield* store.touchSuccessfulRead(grant, "session"));
      const refreshed = (yield* store.lookupGrant(threadId, "run", "run"))!;
      assert.equal(refreshed.lastUsedAt, 61_000);
      yield* TestClock.adjust(Store.grantIdleMillis - 1);
      assert.isTrue(yield* store.touchSuccessfulRead(grant, "session"));
      assert.equal(
        (yield* store.lookupGrant(threadId, "run", "run"))!.lastUsedAt,
        61_000 + Store.grantIdleMillis - 1,
      );
      yield* TestClock.adjust("7 days");
      assert.deepEqual(yield* store.eligibleConnectedSessions(refreshed, ["session"]), {
        status: "expired",
      });
      yield* sql`DELETE FROM auth_connect_devices`;
      yield* sql`DELETE FROM auth_sessions`;
      for (const table of authorityTables) yield* sql`DELETE FROM ${sql(table)}`;
      for (const table of authorityTables)
        assert.deepEqual(yield* sql`SELECT * FROM ${sql(table)}`, []);
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses a successful read revoked between eligibility and the final update", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insert("session", { key: "key" });
    const { store, grant } = yield* bind("session");
    yield* TestClock.adjust("1 minute");
    let revoked = false;
    const accepted = yield* store.touchSuccessfulRead(grant, "session").pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        if (
          revoked ||
          !statement.compile()[0].startsWith("UPDATE lastcode_thread_read_grants SET last_used_at")
        )
          return Effect.succeed(statement);
        revoked = true;
        return sql`UPDATE auth_sessions SET revoked_at = 'revoked' WHERE session_id = 'session'`.pipe(
          Effect.provideService(Statement.CurrentTransformer, undefined),
          Effect.orDie,
          Effect.as(statement),
        );
      }),
    );
    assert.isTrue(revoked);
    assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
    assert.isFalse(accepted);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "hands off only exact compatible sources in a many-to-one replacement and revokes the whole verified family",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const first = yield* insert("desktop-A", {
        subject: "desktop",
        method: "bearer-access-token",
      });
      yield* insert("desktop-B", { subject: "desktop", method: "bearer-access-token" });
      yield* insert("desktop-incompatible", {
        subject: "desktop",
        method: "bearer-access-token",
        scopes: ["orchestration:read", "filesystem:read"],
      });
      yield* insert("unrelated", { subject: "other", method: "bearer-access-token" });
      const a = yield* bind("desktop-A", "A");
      yield* bind("desktop-B", "B");
      yield* bind("desktop-incompatible", "incompatible");
      yield* bind("unrelated", "unrelated");
      const target = { ...first, sessionId: AuthSessionId.make("desktop-current") };
      const replaced = yield* sessions.createReplacingActive({
        session: target,
        revokedAt: first.issuedAt,
      });
      assert.sameMembers([...replaced], ["desktop-A", "desktop-B", "desktop-incompatible"]);
      assert.sameMembers(
        (yield* sql<{
          source_session_id: string;
        }>`SELECT source_session_id FROM lastcode_thread_read_handoffs`).map(
          (row) => row.source_session_id,
        ),
        ["desktop-A", "desktop-B"],
      );
      assert.isUndefined(yield* a.store.lookupGrant(threadId, "run", "incompatible"));
      assert.isDefined(yield* a.store.lookupGrant(threadId, "run", "unrelated"));
      const fresh = yield* bind("desktop-current", "target-direct");
      yield* sessions.revoke({ sessionId: first.sessionId, revokedAt: first.issuedAt });
      for (const id of ["A", "B", "target-direct"])
        assert.isUndefined(yield* a.store.lookupGrant(threadId, "run", id));
      assert.isFalse(
        yield* fresh.store.bindGrant(threadId, "run", "stale-target", fresh.authority, 0),
      );
      assert.isDefined(yield* a.store.lookupGrant(threadId, "run", "unrelated"));
    }).pipe(Effect.provide(layer)),
);

it.effect("preserves first ownership on collision and bounds grant and diagnostic retention", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insert("owner");
    const original = yield* bind("owner");
    yield* insert("other");
    const other = (yield* original.store.captureAuthenticatedSessionAuthority("other"))!;
    assert.isFalse(yield* original.store.bindGrant(threadId, "run", "run", other, 0));
    assert.equal((yield* original.store.lookupGrant(threadId, "run", "run"))!.sessionId, "owner");
    yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n <= ${Store.maxGrantRows})
      INSERT INTO lastcode_thread_read_grants
        SELECT thread_id, kind, 'capacity:' || n, session_id, proof_key, subject, method, scopes, family_id, key_generation, family_generation, n
        FROM lastcode_thread_read_grants CROSS JOIN numbers WHERE grant_id = 'run'`;
    yield* original.store.prune(20_000);
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM lastcode_thread_read_grants`)[0]!
        .count,
      Store.maxGrantRows,
    );
    assert.isUndefined(yield* original.store.lookupGrant(threadId, "run", "run"));
    assert.isFalse(yield* original.store.touchSuccessfulRead(original.grant, "owner"));
    yield* original.store.recordFailure(threadId, "run", "diagnostic", "reauth-required", 0);
    yield* original.store.prune(Store.grantIdleMillis + 1);
    assert.isUndefined(yield* original.store.lookupFailureReason(threadId, "run", "diagnostic"));
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["browser-session-cookie", "bearer-access-token"] as const)(
  "keeps pending inherited %s authority through two compatible replacements and a historical revoke",
  (method) =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const original = yield* insert("source-A", { subject: "paired", method });
      const { store, grant } = yield* bind("source-A");
      const replacement = {
        ...original,
        sessionId: AuthSessionId.make("source-B"),
        scopes: ["orchestration:read", "filesystem:read"] as const,
      };
      yield* sessions.createReplacingActive({
        session: replacement,
        revokedAt: original.issuedAt,
        replaceSessionId: original.sessionId,
      });
      const retained = (yield* store.lookupGrant(threadId, "run", "run"))!;
      assert.equal(retained.sessionId, "source-B");
      assert.equal(retained.familyId, grant.familyId);
      const connected = ["source-B"];
      const inherited = (yield* store.prepareInheritedAuthority(
        retained,
        () => connected,
        (id) => connected.includes(id),
      ))!;
      assert.isDefined(inherited);
      yield* sessions.createReplacingActive({
        session: { ...replacement, sessionId: AuthSessionId.make("source-C") },
        revokedAt: original.issuedAt,
        replaceSessionId: replacement.sessionId,
      });
      connected.splice(0, 1, "source-C");
      assert.deepEqual(yield* store.eligibleConnectedSessions(retained, connected), {
        status: "eligible",
        sessionIds: ["source-C"],
      });
      assert.isTrue(yield* store.bindGrant(threadId, "run", "child", inherited, 0));
      const child = (yield* store.lookupGrant(threadId, "run", "child"))!;
      assert.equal(child.sessionId, "source-C");
      assert.equal(child.familyId, grant.familyId);
      assert.equal(child.familyGeneration, grant.familyGeneration);
      assert.equal(child.keyGeneration, grant.keyGeneration);
      assert.deepEqual(child.scopes, grant.scopes);
      assert.equal(inherited.sessionId, "source-B");
      assert.deepEqual(yield* store.eligibleConnectedSessions(child, connected), {
        status: "eligible",
        sessionIds: ["source-C"],
      });
      assert.isFalse(
        yield* sessions.revoke({ sessionId: original.sessionId, revokedAt: original.issuedAt }),
      );
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "child"));
      assert.isFalse(yield* store.bindGrant(threadId, "run", "revoked-child", inherited, 0));
      assert.deepEqual(yield* store.eligibleConnectedSessions(child, connected), {
        status: "reauth-required",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("rechecks the rightful connected replacement while inherited input is pending", () =>
  Effect.gen(function* () {
    const sessions = yield* AuthSessions.AuthSessionRepository;
    const original = yield* insert("source", {
      subject: "paired",
      method: "browser-session-cookie",
    });
    const { store, grant } = yield* bind("source");
    const connected = ["source"];
    const inherited = (yield* store.prepareInheritedAuthority(
      grant,
      () => connected,
      (id) => connected.includes(id),
    ))!;
    yield* sessions.createReplacingActive({
      session: { ...original, sessionId: AuthSessionId.make("replacement") },
      revokedAt: original.issuedAt,
      replaceSessionId: original.sessionId,
    });
    connected.splice(0, 1, "replacement");
    yield* TestClock.adjust("2 hours");
    assert.isTrue(
      yield* store.bindGrant(threadId, "run", "child", inherited, yield* Clock.currentTimeMillis),
    );
    assert.equal((yield* store.lookupGrant(threadId, "run", "child"))!.sessionId, "replacement");
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["valid-cookie", "approved-expired-connect"] as const)(
  "retains offline sender authority for %s until its rightful client reconnects",
  (source) =>
    Effect.gen(function* () {
      const cookie = source === "valid-cookie";
      yield* insert(
        "source",
        cookie
          ? { subject: "paired", method: "browser-session-cookie", expires: Store.grantIdleMillis }
          : { key: "key" },
      );
      const { store, grant } = yield* bind("source");
      yield* TestClock.adjust("2 hours");
      yield* insert("ambient", { subject: "other", method: "browser-session-cookie" });
      const connected: string[] = [];
      const inherited = yield* store.prepareInheritedAuthority(
        grant,
        () => connected,
        (id) => connected.includes(id),
      );
      assert.isDefined(inherited);
      assert.isTrue(
        yield* store.bindGrant(
          threadId,
          "run",
          "child",
          inherited!,
          yield* Clock.currentTimeMillis,
        ),
      );
      const child = (yield* store.lookupGrant(threadId, "run", "child"))!;
      assert.deepEqual(yield* store.eligibleConnectedSessions(child, []), {
        status: "disconnected",
      });
      assert.deepEqual(yield* store.eligibleConnectedSessions(child, ["ambient"]), {
        status: "disconnected",
      });
      if (!cookie) yield* insert("reconnected", { key: "key" });
      connected.push(cookie ? "source" : "reconnected");
      assert.deepEqual(yield* store.eligibleConnectedSessions(child, connected), {
        status: "eligible",
        sessionIds: [...connected],
      });
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  "cookie-expired",
  "custom-expired",
  "unapproved",
  "revoked",
  "generation-stale",
] as const)(
  "denies offline inheritance from a %s source without borrowing another client",
  (reason) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert(
        "source",
        reason === "cookie-expired"
          ? { subject: "paired", method: "browser-session-cookie" }
          : { key: "key", ...(reason === "custom-expired" ? { subject: "custom-oauth" } : {}) },
      );
      const { store, grant } = yield* bind("source");
      const connected = ["source"];
      const pending = (yield* store.prepareInheritedAuthority(
        grant,
        () => connected,
        (id) => connected.includes(id),
      ))!;
      connected.splice(0, 1, "ambient");
      yield* TestClock.adjust("2 hours");
      yield* insert("ambient");
      if (reason === "unapproved")
        yield* sql`DELETE FROM auth_connect_devices WHERE proof_key_thumbprint = 'key'`;
      if (reason === "revoked")
        yield* sql`UPDATE auth_sessions SET revoked_at = 'revoked' WHERE session_id = 'source'`;
      if (reason === "generation-stale")
        yield* sql`UPDATE lastcode_thread_read_generations SET generation = generation + 1 WHERE id = ${grant.familyId}`;
      if (reason === "unapproved") {
        yield* TestClock.adjust("7 days");
        assert.deepEqual(yield* store.eligibleConnectedSessions(grant, ["ambient"]), {
          status: "revoked",
        });
        assert.equal(yield* store.admissionFailureReason(pending), "revoked");
      }
      if (reason === "cookie-expired" || reason === "custom-expired") {
        assert.deepEqual(yield* store.eligibleConnectedSessions(grant, ["ambient"]), {
          status: "reauth-required",
        });
        assert.equal(yield* store.admissionFailureReason(pending), "reauth-required");
      }
      assert.isUndefined(
        yield* store.prepareInheritedAuthority(
          grant,
          () => ["ambient"],
          () => true,
        ),
      );
      assert.isFalse(
        yield* store.bindGrant(threadId, "run", "child", pending, yield* Clock.currentTimeMillis),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("does not extend seven-day recency through an inherited sender chain without reads", () =>
  Effect.gen(function* () {
    yield* insert("source", {
      subject: "paired",
      method: "browser-session-cookie",
      expires: Store.grantIdleMillis * 2,
    });
    const { store, grant } = yield* bind("source");
    yield* TestClock.adjust(Store.grantIdleMillis - 2);
    let previous = grant;
    for (const id of ["child", "grandchild"]) {
      const inherited = (yield* store.prepareInheritedAuthority(
        previous,
        () => ["source"],
        () => true,
      ))!;
      assert.isDefined(inherited);
      assert.isTrue(
        yield* store.bindGrant(threadId, "run", id, inherited, yield* Clock.currentTimeMillis),
      );
      previous = (yield* store.lookupGrant(threadId, "run", id))!;
      assert.equal(previous.lastUsedAt, grant.lastUsedAt);
      yield* TestClock.adjust(1);
    }
    assert.deepEqual(yield* store.eligibleConnectedSessions(previous, ["source"]), {
      status: "expired",
    });
    assert.isUndefined(
      yield* store.prepareInheritedAuthority(
        previous,
        () => ["source"],
        () => true,
      ),
    );
    const direct = (yield* store.captureAuthenticatedSessionAuthority("source"))!;
    assert.isTrue(
      yield* store.bindGrant(
        threadId,
        "run",
        "new-user-input",
        direct,
        yield* Clock.currentTimeMillis,
      ),
    );
    assert.equal(
      (yield* store.lookupGrant(threadId, "run", "new-user-input"))!.lastUsedAt,
      yield* Clock.currentTimeMillis,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["expired", "pruned"] as const)(
  "denies a pending inherited commit after its exact source grant is %s",
  (reason) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert("source", { key: "key" });
      const { store, grant } = yield* bind("source");
      const inherited = (yield* store.prepareInheritedAuthority(
        grant,
        () => ["source"],
        () => true,
      ))!;
      if (reason === "expired") yield* TestClock.adjust("7 days");
      else {
        yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ${Store.maxGrantRows})
          INSERT INTO lastcode_thread_read_grants
            SELECT thread_id, kind, 'capacity:' || n, session_id, proof_key, subject, method, scopes, family_id, key_generation, family_generation, 1
            FROM lastcode_thread_read_grants CROSS JOIN numbers WHERE grant_id = 'run'`;
        yield* store.prune(1);
        assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
      }
      assert.isFalse(
        yield* store.bindGrant(threadId, "run", "child", inherited, yield* Clock.currentTimeMillis),
      );
    }).pipe(Effect.provide(layer)),
);
