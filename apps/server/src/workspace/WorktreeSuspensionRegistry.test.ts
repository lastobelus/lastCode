import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Registry from "./WorktreeSuspensionRegistry.ts";

const layer = Registry.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest("/project", { prefix: "suspension-registry-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const record: Registry.CheckoutAuthority = {
  checkoutId: "fixture-checkout",
  repositoryRoot: "/project",
  path: "/managed/feature",
  aliases: ["/managed/feature"],
  owners: [],
  summary: {
    checkoutId: "fixture-checkout",
    generation: 0,
    state: "active",
    snapshotId: null,
    lastRestoredAt: null,
    keepWorkspace: false,
  },
  history: [],
  blockedReason: null,
};

it.effect("persists authority privately and rejects a stale generation write", () =>
  Effect.gen(function* () {
    const registry = yield* Registry.WorktreeSuspensionRegistry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    assert.deepStrictEqual(yield* registry.list, []);
    yield* registry.recordUnverifiedUse("/managed/feature", "2026-01-02T00:00:00.000Z");
    yield* registry.recordUnverifiedUse("/managed/feature", "2026-01-01T00:00:00.000Z");
    yield* registry.put(record, null);
    assert.strictEqual(
      yield* registry.unverifiedUse(["/managed/feature"]),
      "2026-01-02T00:00:00.000Z",
    );
    const restored = yield* registry.list;
    assert.deepStrictEqual(restored, [record]);
    const duplicate = {
      ...record,
      checkoutId: "fixture-duplicate",
      summary: { ...record.summary, checkoutId: "fixture-duplicate" },
    };
    assert.strictEqual(
      (yield* registry.put(duplicate, null).pipe(Effect.flip)).operation,
      "ownership-changed",
    );
    assert.deepStrictEqual(yield* registry.list, [record]);
    yield* registry.dependenciesRemoved("/managed/feature");
    yield* registry.dependenciesRemoved("/unknown");
    assert.deepStrictEqual(yield* registry.list, [record]);
    assert.strictEqual((yield* fs.stat(registry.root)).mode & 0o077, 0);
    assert.strictEqual(
      (yield* fs.stat(path.join(registry.root, "authority.json"))).mode & 0o077,
      0,
    );
    const next = { ...record, summary: { ...record.summary, generation: 1, keepWorkspace: true } };
    yield* registry.put(next, record);
    const error = yield* registry.put(record, record).pipe(Effect.flip);
    assert.strictEqual(error.operation, "ownership-changed");
    assert.deepStrictEqual(yield* registry.list, [next]);
    const failed = {
      ...next,
      summary: { ...next.summary, keepWorkspace: false },
      captureFailure: { operationId: "failed-capture", reason: "Unsupported capture" },
    };
    yield* registry.put(failed, next);
    assert.deepStrictEqual(yield* registry.list, [failed]);
    assert.strictEqual(
      yield* registry.automaticProtection("/managed/feature", "dependencies"),
      null,
    );
    for (const target of ["/managed", "/managed/feature/node_modules"]) {
      assert.strictEqual(
        yield* registry.automaticProtection(target, "dependencies"),
        "Unsupported capture",
      );
    }
    for (const target of [
      "/managed/feature",
      "/managed/feature/node_modules",
      "/managed/feature/dist",
      "/managed",
    ]) {
      assert.strictEqual(yield* registry.automaticProtection(target), "Unsupported capture");
    }
    yield* registry.dependenciesRemoved("/managed");
    assert.deepStrictEqual(yield* registry.list, [failed]);
    yield* registry.dependenciesRemoved("/managed/feature");
    const legacy = {
      ...failed,
      captureFailure: { ...failed.captureFailure, retryOnce: true as const },
    };
    assert.deepStrictEqual(yield* registry.list, [legacy]);
    assert.strictEqual(
      yield* registry.automaticProtection("/managed/feature"),
      "Unsupported capture",
    );
    yield* registry.dependenciesRemoved("/managed/feature");
    assert.deepStrictEqual(yield* registry.list, [legacy]);
    yield* registry.put({ ...legacy, lastWorkspaceUseAt: "2026-01-02T00:00:00.000Z" }, legacy);
    assert.isNull(yield* registry.unverifiedUse(["/managed/feature"]));
  }).pipe(Effect.provide(layer)),
);

it.effect("reserves recovery destinations against other checkout claims", () =>
  Effect.gen(function* () {
    const registry = yield* Registry.WorktreeSuspensionRegistry;
    yield* registry.put(record, null);
    const operation = {
      id: "fixture-recovery",
      kind: "recovery" as const,
      snapshotIds: [],
      manual: true,
      acceptedAt: "2026-01-01T00:00:00.000Z",
      destinationPath: "/managed/recovered",
    };
    const pending = { ...record, operation };
    yield* registry.put(pending, record);
    const recovered = {
      ...record,
      checkoutId: operation.id,
      sourceCheckoutId: record.checkoutId,
      path: operation.destinationPath,
      aliases: [operation.destinationPath],
      summary: { ...record.summary, checkoutId: operation.id },
      operation,
    };
    const unrelated = {
      ...record,
      checkoutId: "unrelated",
      path: operation.destinationPath,
      aliases: [operation.destinationPath],
      summary: { ...recovered.summary, checkoutId: "unrelated" },
    };
    assert.strictEqual(
      (yield* registry.put(unrelated, null).pipe(Effect.flip)).operation,
      "ownership-changed",
    );
    yield* registry.put(recovered, null);
    assert.lengthOf(yield* registry.list, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("only permits dependency cleanup for a settled exact failure", () =>
  Effect.gen(function* () {
    const registry = yield* Registry.WorktreeSuspensionRegistry;
    const failed: Registry.CheckoutAuthority = {
      ...record,
      aliases: ["/alias/feature"],
      history: ["retained-history"],
      blockedReason: "retained block",
      lastWorkspaceUseAt: "2026-01-01T00:00:00.000Z",
      captureFailure: { operationId: "failed-capture", reason: "Unsupported capture" },
    };
    yield* registry.put(failed, null);
    assert.strictEqual(yield* registry.automaticProtection("/alias/feature", "dependencies"), null);
    const operation = {
      id: "operation",
      kind: "capture" as const,
      snapshotIds: [],
      manual: false,
      acceptedAt: "2026-01-01T00:00:00.000Z",
    };
    const pending = {
      commandId: CommandId.make("command"),
      threadId: ThreadId.make("thread"),
      checkoutId: record.checkoutId,
      aliases: [],
      expectedOwners: [],
      expected: record.summary,
      next: record.summary,
    } satisfies NonNullable<Registry.CheckoutAuthority["pendingProjection"]>;
    const protectedRecords: Registry.CheckoutAuthority[] = [
      { ...failed, summary: { ...failed.summary, keepWorkspace: true } },
      ...(["capture", "restore", "discard"] as const).map((kind) => ({
        ...failed,
        operation: { ...operation, kind },
      })),
      { ...failed, pendingProjection: pending },
      { ...failed, summary: { ...failed.summary, state: "blocked" } },
    ];
    let current = failed;
    for (const protectedRecord of protectedRecords) {
      yield* registry.put(protectedRecord, current);
      assert.strictEqual(
        yield* registry.automaticProtection("/managed/feature", "dependencies"),
        "Unsupported capture",
      );
      yield* registry.dependenciesRemoved("/managed/feature");
      assert.deepStrictEqual(yield* registry.list, [protectedRecord]);
      current = protectedRecord;
    }
    yield* registry.put(failed, current);
    const overlap = {
      ...failed,
      checkoutId: "overlap",
      path: "/managed",
      aliases: [],
      summary: { ...failed.summary, checkoutId: "overlap" },
    };
    yield* registry.put(overlap, null);
    assert.strictEqual(
      yield* registry.automaticProtection("/managed/feature", "dependencies"),
      "Unsupported capture",
    );
    yield* registry.dependenciesRemoved("/alias/feature");
    assert.deepStrictEqual(yield* registry.list, [
      overlap,
      { ...failed, captureFailure: { ...failed.captureFailure!, retryOnce: true } },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("retains an unreadable catalog and refuses replacement", () =>
  Effect.gen(function* () {
    const registry = yield* Registry.WorktreeSuspensionRegistry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* registry.put(record, null);
    const catalog = path.join(registry.root, "authority.json");
    yield* fs.writeFileString(catalog, "incomplete catalog", { mode: 0o600 });
    assert.strictEqual((yield* registry.list.pipe(Effect.flip)).operation, "read");
    yield* registry.put(record, null).pipe(Effect.flip);
    assert.strictEqual(yield* fs.readFileString(catalog), "incomplete catalog");
  }).pipe(Effect.provide(layer)),
);

it.effect("does not follow a redirected authority file", () =>
  Effect.gen(function* () {
    const registry = yield* Registry.WorktreeSuspensionRegistry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* registry.put(record, null);
    const other = path.join(registry.root, "retained-note");
    const catalog = path.join(registry.root, "authority.json");
    yield* fs.writeFileString(other, "keep this note", { mode: 0o600 });
    yield* fs.remove(catalog);
    yield* fs.symlink(other, catalog);
    assert.strictEqual((yield* registry.list.pipe(Effect.flip)).operation, "read");
    yield* registry.put(record, null).pipe(Effect.flip);
    assert.strictEqual(yield* fs.readFileString(other), "keep this note");
  }).pipe(Effect.provide(layer)),
);
