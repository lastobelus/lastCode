import {
  WorktreeSuspensionOwner,
  WorktreeSuspensionSummary,
  TrimmedNonEmptyString,
  WorktreeSuspensionTransitionInput,
  IsoDateTime,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  ProjectId,
  ThreadId,
  CommandId,
  WorkspaceLifecycleTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";

export const CheckoutAuthority = Schema.Struct({
  checkoutId: TrimmedNonEmptyString,
  repositoryRoot: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  aliases: Schema.Array(TrimmedNonEmptyString),
  owners: Schema.Array(WorktreeSuspensionOwner),
  summary: WorktreeSuspensionSummary,
  history: Schema.Array(TrimmedNonEmptyString),
  snapshots: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        snapshotId: TrimmedNonEmptyString,
        savedAt: IsoDateTime,
        head: TrimmedNonEmptyString,
        branch: Schema.NullOr(Schema.String),
        bytes: Schema.Number,
        fileCount: Schema.Number,
        owners: Schema.Array(WorktreeSuspensionOwner),
      }),
    ),
  ),
  blockedReason: Schema.NullOr(Schema.String),
  captureFailure: Schema.optionalKey(
    Schema.Struct({
      operationId: TrimmedNonEmptyString,
      reason: Schema.String,
      retryOnce: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  lastWorkspaceUseAt: Schema.optionalKey(IsoDateTime),
  lastHead: Schema.optionalKey(TrimmedNonEmptyString),
  sourceCheckoutId: Schema.optionalKey(TrimmedNonEmptyString),
  detached: Schema.optionalKey(Schema.Boolean),
  pendingProjection: Schema.optionalKey(WorktreeSuspensionTransitionInput),
  nativeIdentity: Schema.optionalKey(
    Schema.Struct({
      sourceIdentity: Schema.Struct({ dev: Schema.Number, ino: Schema.Number }),
      gitDirectory: Schema.String,
      gitDirectoryIdentity: Schema.Struct({ dev: Schema.Number, ino: Schema.Number }),
      commonDirectory: Schema.String,
      commonIdentity: Schema.Struct({ dev: Schema.Number, ino: Schema.Number }),
    }),
  ),
  recoveryThread: Schema.optionalKey(
    Schema.Struct({
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
      title: Schema.String,
    }),
  ),
  operation: Schema.optionalKey(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      kind: Schema.Literals(["capture", "restore", "discard", "fresh", "recovery"]),
      snapshotIds: Schema.Array(TrimmedNonEmptyString),
      manual: Schema.Boolean,
      acceptedAt: IsoDateTime,
      destinationPath: Schema.optionalKey(TrimmedNonEmptyString),
      recoveryProjectId: Schema.optionalKey(ProjectId),
      recoveryThreadId: Schema.optionalKey(ThreadId),
      branch: Schema.optionalKey(TrimmedNonEmptyString),
      consentCommitted: Schema.optionalKey(Schema.Boolean),
      lifecycle: Schema.optionalKey(
        Schema.Struct({
          commandId: CommandId,
          operation: Schema.Literals(["archive", "delete"]),
          threadIds: Schema.Array(ThreadId),
          target: WorkspaceLifecycleTarget,
          deleteReceipts: Schema.optionalKey(
            Schema.Array(Schema.Struct({ threadId: ThreadId, commandId: CommandId })).check(
              Schema.isMinLength(1),
              Schema.isMaxLength(100),
            ),
          ),
          projectId: Schema.optionalKey(ProjectId),
        }),
      ),
    }),
  ),
});
export type CheckoutAuthority = typeof CheckoutAuthority.Type;

const Catalog = Schema.Struct({
  version: Schema.Literal(1),
  checkouts: Schema.Array(CheckoutAuthority).check(Schema.isMaxLength(10_000)),
});
const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalog));
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(Catalog));
const encodeAuthority = Schema.encodeSync(Schema.fromJsonString(CheckoutAuthority));
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export class SuspensionRegistryError extends Schema.TaggedError<SuspensionRegistryError>()(
  "SuspensionRegistryError",
  {
    operation: Schema.Literals(["read", "write", "ownership-changed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.operation === "ownership-changed"
      ? "Saved workspace ownership changed. Refresh before continuing."
      : "The saved workspace catalog is unavailable. Recovery data has been retained.";
  }
}

const isRegistryError = Schema.is(SuspensionRegistryError);

export class WorktreeSuspensionRegistry extends Context.Service<
  WorktreeSuspensionRegistry,
  {
    readonly root: string;
    readonly list: Effect.Effect<ReadonlyArray<CheckoutAuthority>, SuspensionRegistryError>;
    readonly automaticProtection: (
      workspacePath: string,
    ) => Effect.Effect<string | null, SuspensionRegistryError>;
    readonly put: (
      next: CheckoutAuthority,
      expected: CheckoutAuthority | null,
    ) => Effect.Effect<void, SuspensionRegistryError>;
  }
>()("t3/workspace/WorktreeSuspensionRegistry") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const mutex = yield* Semaphore.make(1);
  const stateRoot = yield* fs.realPath(config.stateDir);
  const root = path.join(stateRoot, "worktree-suspension");
  const catalogPath = path.join(root, "authority.json");

  const verifyRoot = Effect.fn("WorktreeSuspensionRegistry.verifyRoot")(function* () {
    const parent = yield* fs.realPath(stateRoot);
    if (parent !== stateRoot) {
      return yield* new SuspensionRegistryError({ operation: "read" });
    }
    const created = yield* fs.makeDirectory(root, { mode: 0o700 }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
    const actual = yield* fs.realPath(root);
    const info = yield* fs.stat(root);
    if (actual !== root || info.type !== "Directory" || (info.mode & 0o077) !== 0) {
      return yield* new SuspensionRegistryError({ operation: "read" });
    }
    if (created)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.open(stateRoot, { flag: "r" });
          yield* directory.sync;
        }),
      );
  });

  const read = Effect.fn("WorktreeSuspensionRegistry.read")(function* () {
    yield* verifyRoot();
    if (!(yield* fs.exists(catalogPath))) {
      if ((yield* fs.readDirectory(root)).length !== 0)
        return yield* new SuspensionRegistryError({ operation: "read" });
      return [];
    }
    if ((yield* fs.realPath(catalogPath)) !== catalogPath) {
      return yield* new SuspensionRegistryError({ operation: "read" });
    }
    const info = yield* fs.stat(catalogPath);
    if (
      info.type !== "File" ||
      Number(info.size) > MAX_CATALOG_BYTES ||
      (info.mode & 0o077) !== 0
    ) {
      return yield* new SuspensionRegistryError({ operation: "read" });
    }
    const value = yield* decodeCatalog(yield* fs.readFileString(catalogPath));
    if (
      new Set(value.checkouts.map((entry) => entry.checkoutId)).size !== value.checkouts.length ||
      value.checkouts.some((entry) => entry.checkoutId !== entry.summary.checkoutId)
    ) {
      return yield* new SuspensionRegistryError({ operation: "read" });
    }
    return value.checkouts;
  });
  const list = read().pipe(
    Effect.mapError((cause) => new SuspensionRegistryError({ operation: "read", cause })),
  );
  const put = Effect.fn("WorktreeSuspensionRegistry.put")(
    function* (next: CheckoutAuthority, expected: CheckoutAuthority | null) {
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* list;
          const existing = current.find((entry) => entry.checkoutId === next.checkoutId) ?? null;
          if (
            existing === null || expected === null
              ? existing !== expected
              : encodeAuthority(existing) !== encodeAuthority(expected)
          ) {
            return yield* new SuspensionRegistryError({ operation: "ownership-changed" });
          }
          const contents = yield* encodeCatalog({
            version: 1,
            checkouts: [...current.filter((entry) => entry.checkoutId !== next.checkoutId), next],
          });
          if (new TextEncoder().encode(contents).byteLength > MAX_CATALOG_BYTES) {
            return yield* new SuspensionRegistryError({ operation: "write" });
          }
          const temporary = path.join(root, `authority-${yield* crypto.randomUUIDv4()}.tmp`);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(new TextEncoder().encode(contents));
              yield* file.sync;
            }),
          );
          yield* fs.rename(temporary, catalogPath);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fs.open(root, { flag: "r" });
              yield* directory.sync;
            }),
          );
        }),
      );
    },
    Effect.mapError((cause) =>
      isRegistryError(cause) ? cause : new SuspensionRegistryError({ operation: "write", cause }),
    ),
  );
  const automaticProtection = Effect.fn("WorktreeSuspensionRegistry.automaticProtection")(
    function* (workspacePath: string) {
      const candidate = path.resolve(workspacePath);
      const overlaps = (other: string) => {
        const relative = path.relative(candidate, other);
        const inverse = path.relative(other, candidate);
        const inside = (value: string) =>
          value === "" ||
          (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
        return inside(relative) || inside(inverse);
      };
      for (const entry of yield* list) {
        if (entry.detached) continue;
        if (!entry.aliases.some(overlaps) && !overlaps(entry.path)) continue;
        if (entry.captureFailure !== undefined) return entry.captureFailure.reason;
        if (entry.summary.keepWorkspace) return "Keep workspace is enabled.";
        if (
          entry.pendingProjection !== undefined ||
          (entry.operation !== undefined && entry.operation.kind !== "discard")
        )
          return "The workspace is protected by a saved-workspace operation.";
        if (entry.summary.state !== "active" && entry.summary.state !== "discarded")
          return "The workspace is protected by a saved-workspace operation.";
      }
      return null;
    },
  );
  return WorktreeSuspensionRegistry.of({ root, list, put, automaticProtection });
});

export const layer = Layer.effect(WorktreeSuspensionRegistry, make);
