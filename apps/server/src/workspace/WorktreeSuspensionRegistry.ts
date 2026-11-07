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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import { canonicalProjectRoot } from "./projectRootLease.ts";

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
  unverifiedUses: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: TrimmedNonEmptyString, usedAt: IsoDateTime })).check(
      Schema.isMaxLength(10_000),
    ),
  ),
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
    readonly recordUnverifiedUse: (
      workspacePath: string,
      usedAt: string,
    ) => Effect.Effect<void, SuspensionRegistryError>;
    readonly unverifiedUse: (
      workspacePaths: readonly string[],
    ) => Effect.Effect<string | null, SuspensionRegistryError>;
    readonly automaticProtection: (
      workspacePath: string,
      resource?: "worktree" | "dependencies",
    ) => Effect.Effect<string | null, SuspensionRegistryError>;
    readonly recoveryDestinationProtection: (
      workspacePath: string,
    ) => Effect.Effect<string | null, SuspensionRegistryError>;
    /** Called after verified dependency removal while the checkout lease is held. */
    readonly dependenciesRemoved: (
      workspacePath: string,
    ) => Effect.Effect<void, SuspensionRegistryError>;
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
  const random = yield* SecureRandom.SecureRandom;
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
      return { version: 1 as const, checkouts: [], unverifiedUses: [] };
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
    return value;
  });
  const catalog = read().pipe(
    Effect.mapError((cause) => new SuspensionRegistryError({ operation: "read", cause })),
  );
  const list = catalog.pipe(Effect.map((value) => value.checkouts));
  const write = Effect.fn("WorktreeSuspensionRegistry.write")(function* (
    value: typeof Catalog.Type,
  ) {
    const contents = yield* encodeCatalog(value);
    if (new TextEncoder().encode(contents).byteLength > MAX_CATALOG_BYTES)
      return yield* new SuspensionRegistryError({ operation: "write" });
    const temporary = path.join(root, `authority-${yield* random.uuidV4()}.tmp`);
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
  });
  const put = Effect.fn("WorktreeSuspensionRegistry.put")(
    function* (next: CheckoutAuthority, expected: CheckoutAuthority | null) {
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* catalog;
          const existing =
            current.checkouts.find((entry) => entry.checkoutId === next.checkoutId) ?? null;
          if (
            existing === null || expected === null
              ? existing !== expected
              : encodeAuthority(existing) !== encodeAuthority(expected)
          ) {
            return yield* new SuspensionRegistryError({ operation: "ownership-changed" });
          }
          const samePath = (left: string, right: string) =>
            path.resolve(left) === path.resolve(right);
          const nextPaths = next.detached ? [] : [next.path, ...next.aliases];
          const nextDestination =
            next.operation?.kind === "recovery" || next.operation?.kind === "restore"
              ? next.operation.destinationPath
              : undefined;
          if (
            (nextPaths.length > 0 || nextDestination !== undefined) &&
            current.checkouts.some((entry) => {
              if (entry.checkoutId === next.checkoutId) return false;
              const entryPaths = entry.detached ? [] : [entry.path, ...entry.aliases];
              const entryDestination =
                entry.operation?.kind === "recovery" || entry.operation?.kind === "restore"
                  ? entry.operation.destinationPath
                  : undefined;
              const sameRecovery =
                (entry.operation?.kind === "recovery" &&
                  next.sourceCheckoutId === entry.checkoutId &&
                  next.checkoutId === entry.operation?.id) ||
                (next.operation?.kind === "recovery" &&
                  entry.sourceCheckoutId === next.checkoutId &&
                  entry.checkoutId === next.operation?.id);
              return (
                (expected === null &&
                  entryPaths.some((alias) =>
                    nextPaths.some((candidate) => samePath(alias, candidate)),
                  )) ||
                (!sameRecovery &&
                  entryDestination !== undefined &&
                  nextPaths.some((candidate) => samePath(candidate, entryDestination))) ||
                (!sameRecovery &&
                  nextDestination !== undefined &&
                  [
                    ...entryPaths,
                    ...(entryDestination === undefined ? [] : [entryDestination]),
                  ].some((candidate) => samePath(candidate, nextDestination)))
              );
            })
          )
            return yield* new SuspensionRegistryError({ operation: "ownership-changed" });
          yield* write({
            ...current,
            checkouts: [
              ...current.checkouts.filter((entry) => entry.checkoutId !== next.checkoutId),
              next,
            ],
            ...(current.unverifiedUses === undefined
              ? {}
              : {
                  unverifiedUses: current.unverifiedUses.filter(
                    (entry) =>
                      next.lastWorkspaceUseAt === undefined ||
                      entry.usedAt > next.lastWorkspaceUseAt ||
                      ![next.path, ...next.aliases].some(
                        (alias) => path.resolve(alias) === entry.path,
                      ),
                  ),
                }),
          });
        }),
      );
    },
    Effect.mapError((cause) =>
      isRegistryError(cause) ? cause : new SuspensionRegistryError({ operation: "write", cause }),
    ),
  );
  const recordUnverifiedUse = Effect.fn("WorktreeSuspensionRegistry.recordUnverifiedUse")(
    function* (workspacePath: string, usedAt: string) {
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* catalog;
          const candidate = path.resolve(workspacePath);
          const existing = current.unverifiedUses?.find((entry) => entry.path === candidate);
          yield* write({
            ...current,
            unverifiedUses: [
              ...(current.unverifiedUses ?? []).filter((entry) => entry.path !== candidate),
              {
                path: candidate,
                usedAt: existing && existing.usedAt > usedAt ? existing.usedAt : usedAt,
              },
            ],
          });
        }),
      );
    },
    Effect.mapError((cause) =>
      isRegistryError(cause) ? cause : new SuspensionRegistryError({ operation: "write", cause }),
    ),
  );
  const unverifiedUse = (workspacePaths: readonly string[]) =>
    catalog.pipe(
      Effect.map((current) => {
        const candidates = new Set(workspacePaths.map((entry) => path.resolve(entry)));
        return (
          (current.unverifiedUses ?? [])
            .filter((entry) => candidates.has(entry.path))
            .map((entry) => entry.usedAt)
            .sort()
            .at(-1) ?? null
        );
      }),
    );
  const settledActive = (entry: CheckoutAuthority) =>
    !entry.detached &&
    entry.summary.state === "active" &&
    !entry.summary.keepWorkspace &&
    entry.operation === undefined &&
    entry.pendingProjection === undefined;
  const exactMatch = (entry: CheckoutAuthority, candidate: string) =>
    [entry.path, ...entry.aliases].some((alias) => path.resolve(alias) === candidate);
  const canonical = (value: string) =>
    canonicalProjectRoot(value).pipe(
      Effect.mapError((cause) => new SuspensionRegistryError({ operation: "read", cause })),
    );
  const pathsOverlap = (first: string, second: string) => {
    const inside = (value: string) =>
      value === "" ||
      (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
    return inside(path.relative(first, second)) || inside(path.relative(second, first));
  };
  const recoveryDestination = (entry: CheckoutAuthority) =>
    entry.operation?.kind === "recovery" || entry.operation?.kind === "restore"
      ? entry.operation.destinationPath
      : undefined;
  const recoveryDestinationProtection = Effect.fn(
    "WorktreeSuspensionRegistry.recoveryDestinationProtection",
  )(function* (workspacePath: string) {
    const destinations = (yield* list)
      .map(recoveryDestination)
      .filter((value) => value !== undefined);
    if (destinations.length === 0) return null;
    const candidate = yield* canonical(workspacePath);
    for (const destination of destinations) {
      if (pathsOverlap(candidate, yield* canonical(destination)))
        return "The workspace is protected by a saved-workspace operation.";
    }
    return null;
  });

  const automaticProtection = Effect.fn("WorktreeSuspensionRegistry.automaticProtection")(
    function* (workspacePath: string, resource: "worktree" | "dependencies" = "worktree") {
      const candidate = path.resolve(workspacePath);
      const overlaps = (other: string) => pathsOverlap(candidate, other);
      let canonicalCandidate: string | undefined;
      for (const entry of yield* list) {
        const destination = recoveryDestination(entry);
        let destinationMatches = destination !== undefined && overlaps(destination);
        if (destination !== undefined && !destinationMatches) {
          canonicalCandidate ??= yield* canonical(candidate);
          destinationMatches = pathsOverlap(canonicalCandidate, yield* canonical(destination));
        }
        if (entry.detached && !destinationMatches) continue;
        if (!destinationMatches && !entry.aliases.some(overlaps) && !overlaps(entry.path)) continue;
        // A settled failed save protects source, but cannot veto an independent
        // dependency policy whose recognition, inactivity and consumer guards pass.
        if (
          entry.captureFailure !== undefined &&
          !(resource === "dependencies" && exactMatch(entry, candidate) && settledActive(entry))
        )
          return entry.captureFailure.reason;
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
  const dependenciesRemoved = Effect.fn("WorktreeSuspensionRegistry.dependenciesRemoved")(
    function* (workspacePath: string) {
      const candidate = path.resolve(workspacePath);
      for (const entry of yield* list) {
        if (
          !exactMatch(entry, candidate) ||
          !settledActive(entry) ||
          entry.captureFailure === undefined ||
          entry.captureFailure.retryOnce
        )
          continue;
        yield* put(
          { ...entry, captureFailure: { ...entry.captureFailure, retryOnce: true } },
          entry,
        );
      }
    },
  );
  return WorktreeSuspensionRegistry.of({
    root,
    list,
    put,
    recordUnverifiedUse,
    unverifiedUse,
    automaticProtection,
    recoveryDestinationProtection,
    dependenciesRemoved,
  });
});

export const layer = Layer.effect(WorktreeSuspensionRegistry, make);
