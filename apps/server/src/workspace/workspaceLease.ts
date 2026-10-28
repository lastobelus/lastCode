import * as NodePath from "@effect/platform-node/NodePath";
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
    const linked = yield* fs
      .readLink(gitPath)
      .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
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
