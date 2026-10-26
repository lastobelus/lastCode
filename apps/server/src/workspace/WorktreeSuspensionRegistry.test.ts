import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Registry from "./WorktreeSuspensionRegistry.ts";

const layer = Registry.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest("/project", { prefix: "suspension-registry-" })),
  Layer.provideMerge(NodeServices.layer),
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
    yield* registry.put(record, null);
    const restored = yield* registry.list;
    assert.deepStrictEqual(restored, [record]);
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
