import * as NodePath from "@effect/platform-node/NodePath";
import * as Deferred from "effect/Deferred";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<
  string,
  { semaphore: Semaphore.Semaphore; users: number; ownerFiberId: number | null }
>();
const registeredRoots = new Map<string, string>();
const platformLayer = Layer.merge(NodePath.layer, NodeFileSystem.layer);

export const registerWorkspaceLeaseRoot = Effect.fn("registerWorkspaceLeaseRoot")(function* (
  root: string,
  aliases: ReadonlyArray<string> = [],
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const canonicalRoot = yield* fs
    .realPath(root)
    .pipe(Effect.orElseSucceed(() => path.resolve(root)));
  for (const alias of [root, canonicalRoot, ...aliases])
    registeredRoots.set(path.resolve(alias), canonicalRoot);
}, Effect.provide(platformLayer));

export const retireWorkspaceLeaseAliases = Effect.fn("retireWorkspaceLeaseAliases")(function* (
  root: string,
  aliases: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => lexicalRoot));
  for (const alias of aliases) {
    const resolvedAlias = path.resolve(alias);
    if (
      resolvedAlias !== lexicalRoot &&
      resolvedAlias !== canonicalRoot &&
      registeredRoots.get(resolvedAlias) === canonicalRoot
    )
      registeredRoots.delete(resolvedAlias);
  }
}, Effect.provide(platformLayer));

export const resolveWorkspaceLeaseRoot = Effect.fn("resolveWorkspaceLeaseRoot")(function* (
  cwd: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const lexical = path.resolve(cwd);
  const registered = (candidate: string) => {
    let match: { alias: string; root: string } | undefined;
    for (const [alias, root] of registeredRoots) {
      const relative = path.relative(alias, candidate);
      if (
        (relative === "" ||
          (!path.isAbsolute(relative) &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`))) &&
        (match === undefined || alias.length > match.alias.length)
      )
        match = { alias, root };
    }
    return match?.root;
  };
  const known = registered(lexical);
  if (known !== undefined) return known;
  const canonical = yield* fs.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  const canonicalKnown = registered(canonical);
  if (canonicalKnown !== undefined) return canonicalKnown;
  for (let candidate = canonical; ; candidate = path.dirname(candidate)) {
    const gitPath = path.join(candidate, ".git");
    const linked = yield* fs.readLink(gitPath).pipe(Effect.isSuccess);
    if (
      !linked &&
      (yield* fs.stat(gitPath).pipe(
        Effect.map((stat) => stat.type === "File" || stat.type === "Directory"),
        Effect.orElseSucceed(() => false),
      ))
    ) {
      registeredRoots.set(candidate, candidate);
      return candidate;
    }
    if (path.dirname(candidate) === candidate) return canonical;
  }
}, Effect.provide(platformLayer));

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(resolveWorkspaceLeaseRoot(cwd), (workspacePath) =>
    Effect.withFiber((fiber) => {
      const lease = leases.get(workspacePath) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
        ownerFiberId: null,
      };
      // Nested startup services share the caller's lease. A child fiber has its
      // own id and must wait, even when it inherited the caller's context.
      if (lease.ownerFiberId === fiber.id) return effect;
      leases.set(workspacePath, lease);
      lease.users++;
      return lease.semaphore
        .withPermit(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              lease.ownerFiberId = fiber.id;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                lease.ownerFiberId = null;
              }),
          ),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lease.users--;
              if (lease.users === 0) leases.delete(workspacePath);
            }),
          ),
        );
    }),
  );

// A restore rewrites files under its directory, so it must exclude provider
// startup in any overlapping workspace: symlink aliases, parents, and children.
// Restores also call Git work that leases the project root.
interface Reservation {
  readonly cwd: string;
  readonly kind: "restore" | "turn-start";
}

const reservations = new Set<Reservation>();
let reservationReleased = Deferred.makeUnsafe<void>();

// path.relative folds win32 drive-letter case and treats a POSIX backslash as
// part of a name, unlike a raw prefix check.
const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const conflicts = (path: Path.Path, a: Reservation, b: Reservation) =>
  (a.kind === "restore" || b.kind === "restore") &&
  (contains(path, a.cwd, b.cwd) || contains(path, b.cwd, a.cwd));

const reserve = (path: Path.Path, reservation: Reservation): Effect.Effect<void> =>
  Effect.suspend(() => {
    for (const held of reservations) {
      if (conflicts(path, held, reservation)) {
        return Deferred.await(reservationReleased).pipe(Effect.andThen(reserve(path, reservation)));
      }
    }
    reservations.add(reservation);
    return Effect.void;
  });

const release = (reservation: Reservation) =>
  Effect.sync(() => {
    if (!reservations.delete(reservation)) return;
    const released = reservationReleased;
    reservationReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  });

// A worktree removed by storage cleanup is recreated inside the reserved
// section, so resolve its nearest existing ancestor: a symlink alias above it
// must still canonicalize the same on both sides. Walks at most the path depth.
const canonicalize = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : canonicalize(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
    Effect.orElseSucceed(() => target),
  );

const withReservation =
  (kind: Reservation["kind"]) =>
  <A, E, R>(
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    canonicalize(fileSystem, path, cwd).pipe(
      Effect.flatMap((canonical) => {
        const reservation: Reservation = { cwd: canonical, kind };
        return reserve(path, reservation).pipe(
          Effect.andThen(effect),
          Effect.ensuring(release(reservation)),
        );
      }),
    );

/** Exclusive over every overlapping workspace while checkpoint files are restored. */
export const withCheckpointRestoreReservation = withReservation("restore");

/** Waits out overlapping restores; turn startups never wait on each other. */
export const withTurnStartReservation = withReservation("turn-start");
