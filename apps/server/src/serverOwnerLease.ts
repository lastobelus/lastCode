// @effect-diagnostics nodeBuiltinImport:off -- The server process owns a kernel-backed local lock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const DARWIN_O_EXLOCK = 0x20;
const DARWIN_O_NOFOLLOW = 0x100;

export class ServerOwnerLeaseHeldError extends Schema.TaggedErrorClass<ServerOwnerLeaseHeldError>()(
  "ServerOwnerLeaseHeldError",
  {
    baseDir: Schema.String,
  },
) {
  override get message() {
    return `Another T3 Code server already owns ${this.baseDir}. Stop that server or choose a different --base-dir.`;
  }
}

export class ServerOwnerLeaseUnavailableError extends Schema.TaggedErrorClass<ServerOwnerLeaseUnavailableError>()(
  "ServerOwnerLeaseUnavailableError",
  {
    baseDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `T3 Code could not acquire the server-owner lease for ${this.baseDir}.`;
  }
}

const isServerOwnerLeaseHeldError = Schema.is(ServerOwnerLeaseHeldError);
const isServerOwnerLeaseUnavailableError = Schema.is(ServerOwnerLeaseUnavailableError);

export interface ServerOwnerLease {
  readonly endpoint: string;
  readonly release: Effect.Effect<void>;
}

function canonicalizeBaseDir(baseDir: string): string {
  const resolved = NodePath.resolve(baseDir);
  try {
    return NodeFS.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function getServerOwnerLeaseLockPath(baseDir: string): string {
  return NodePath.join(canonicalizeBaseDir(baseDir), "server-owner.lock");
}

function releaseServerOwnerLease(release: () => Promise<void>): Effect.Effect<void> {
  let released = false;
  return Effect.suspend(() => {
    if (released) return Effect.void;
    released = true;
    return Effect.tryPromise({ try: release, catch: () => undefined }).pipe(Effect.orDie);
  });
}

function assertRegularLockPath(endpoint: string): void {
  try {
    if (!NodeFS.lstatSync(endpoint).isFile()) {
      throw new Error("The server-owner lock path is not a regular file.");
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
}

function acquireDarwinServerOwnerLease(baseDir: string): ServerOwnerLease {
  const endpoint = getServerOwnerLeaseLockPath(baseDir);
  NodeFS.mkdirSync(NodePath.dirname(endpoint), { recursive: true });
  try {
    assertRegularLockPath(endpoint);
  } catch (cause) {
    throw new ServerOwnerLeaseUnavailableError({ baseDir, cause });
  }
  const flags =
    NodeFS.constants.O_CREAT |
    NodeFS.constants.O_RDWR |
    NodeFS.constants.O_NONBLOCK |
    DARWIN_O_EXLOCK |
    DARWIN_O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = NodeFS.openSync(endpoint, flags, 0o600);
  } catch (cause) {
    if (
      (cause as NodeJS.ErrnoException).code === "EAGAIN" ||
      (cause as NodeJS.ErrnoException).code === "EWOULDBLOCK"
    ) {
      throw new ServerOwnerLeaseHeldError({ baseDir });
    }
    throw new ServerOwnerLeaseUnavailableError({ baseDir, cause });
  }
  try {
    if (!NodeFS.fstatSync(descriptor).isFile()) {
      throw new Error("The server-owner lock path is not a regular file.");
    }
  } catch (cause) {
    NodeFS.closeSync(descriptor);
    throw new ServerOwnerLeaseUnavailableError({ baseDir, cause });
  }
  return {
    endpoint,
    release: releaseServerOwnerLease(async () => NodeFS.closeSync(descriptor)),
  };
}

async function acquireServerOwnerLeasePromise(baseDir: string): Promise<ServerOwnerLease> {
  // This lease protects the LastCode macOS service boundary. Other platforms
  // retain their established server startup behavior until they have an equally
  // kernel-backed primitive; they must not use a stale-path or PID-file fallback.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- O_EXLOCK is Darwin-specific and has no portable Node abstraction.
  if (process.platform !== "darwin") return { endpoint: "unmanaged", release: Effect.void };
  return acquireDarwinServerOwnerLease(baseDir);
}

export const acquireServerOwnerLease = Effect.fn("acquireServerOwnerLease")(function* (
  baseDir: string,
): Effect.fn.Return<
  ServerOwnerLease,
  ServerOwnerLeaseHeldError | ServerOwnerLeaseUnavailableError
> {
  return yield* Effect.tryPromise({
    try: () => acquireServerOwnerLeasePromise(baseDir),
    catch: (cause) =>
      isServerOwnerLeaseHeldError(cause) || isServerOwnerLeaseUnavailableError(cause)
        ? cause
        : new ServerOwnerLeaseUnavailableError({ baseDir, cause }),
  });
});
