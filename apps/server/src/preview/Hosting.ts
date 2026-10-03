import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  PREVIEW_URL_MAX_LENGTH,
  ProviderInstanceId,
  ThreadId,
  PreviewHostingLeaseId,
  type PreviewHostingLeaseSummary as ContractPreviewHostingLeaseSummary,
  type TerminalOpenInput,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as PortScanner from "./PortScanner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export const PREVIEW_HOSTING_LEASE_MS = 24 * 60 * 60 * 1_000;
const READY_TIMEOUT_MS = 30_000;
const EXPIRED_TERMINAL_RETRY_MS = 60_000;
const STATE_VERSION = 1;
const HOSTING_STATE_FILE = "preview-hosting.json";

const LeaseStatus = Schema.Literals(["starting", "active", "expired"]);
const EnvironmentOverrides = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(Schema.isMaxLength(128)),
  Schema.String.check(Schema.isMaxLength(8_192)),
).check(Schema.isMaxProperties(128));

export const PreviewHostingLease = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  terminalId: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  env: Schema.optional(EnvironmentOverrides),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  url: Schema.String.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH)),
  handedOffAt: Schema.String,
  expiresAt: Schema.String,
  status: LeaseStatus,
});
export type PreviewHostingLease = typeof PreviewHostingLease.Type;

export const toPreviewHostingLeaseSummary = (
  lease: PreviewHostingLease,
): ContractPreviewHostingLeaseSummary => ({
  leaseId: PreviewHostingLeaseId.make(lease.id),
  threadId: ThreadId.make(lease.threadId),
  url: lease.url,
  handedOffAt: lease.handedOffAt,
  expiresAt: lease.expiresAt,
  status: lease.status === "expired" ? "starting" : lease.status,
});

const PersistedPreviewHostingState = Schema.Struct({
  version: Schema.Literal(STATE_VERSION),
  leases: Schema.Array(PreviewHostingLease),
});
type PersistedPreviewHostingState = typeof PersistedPreviewHostingState.Type;

export class PreviewHostingError extends Schema.TaggedError<PreviewHostingError>()(
  "PreviewHostingError",
  {
    operation: Schema.Literals(["validate", "read", "decode", "persist", "ready"]),
    statePath: Schema.String,
    threadId: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "validate":
        return this.detail ?? "Invalid preview launch details.";
      case "ready":
        return `Preview did not become reachable before the recovery deadline: ${this.url ?? "unknown URL"}.`;
      case "read":
        return `Failed to read preview leases at ${this.statePath}.`;
      case "decode":
        return `Failed to decode preview leases at ${this.statePath}.`;
      case "persist":
        return `Failed to persist preview leases at ${this.statePath}.`;
    }
  }
}

export class PreviewHosting extends Context.Service<
  PreviewHosting,
  {
    readonly launch: (input: {
      readonly threadId: string;
      readonly command: string;
      readonly cwd: string;
      readonly worktreePath?: string | null;
      readonly env?: TerminalOpenInput["env"];
      readonly providerInstanceId?: TerminalOpenInput["providerInstanceId"];
      readonly url: string;
    }) => Effect.Effect<PreviewHostingLease, PreviewHostingError | TerminalManager.TerminalError>;
    readonly recover: (input: {
      readonly threadId: string;
      readonly leaseId: PreviewHostingLeaseId;
      readonly url: string;
    }) => Effect.Effect<
      PreviewHostingLease | null,
      PreviewHostingError | TerminalManager.TerminalError
    >;
    readonly list: (
      threadId?: string,
    ) => Effect.Effect<ReadonlyArray<PreviewHostingLease>, PreviewHostingError>;
    readonly ownsTerminal: (
      threadId: string,
      terminalId: string,
    ) => Effect.Effect<boolean, PreviewHostingError>;
    readonly removeThread: (
      threadId: string,
    ) => Effect.Effect<void, PreviewHostingError | TerminalManager.TerminalError>;
    readonly protectedWorkspacePaths: () => Effect.Effect<
      ReadonlyArray<string>,
      PreviewHostingError
    >;
  }
>()("t3/preview/Hosting/PreviewHosting") {}

const decodedState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedPreviewHostingState),
);

const normalizeLocalHttpUrl = (value: string): string | null => {
  if (value.length > PREVIEW_URL_MAX_LENGTH) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) {
      return null;
    }
    return url.href.length <= PREVIEW_URL_MAX_LENGTH ? url.href : null;
  } catch {
    return null;
  }
};

const sameEnvironment = (
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean => {
  const leftEntries = Object.entries(left ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => {
      const other = rightEntries[index];
      return other !== undefined && key === other[0] && value === other[1];
    })
  );
};

const discoveryUrl = (value: string): string => {
  const url = new URL(value);
  url.hash = "";
  if (url.hostname === "0.0.0.0") url.hostname = "localhost";
  return url.href;
};

const discoveryPortKey = (value: string): string => {
  const url = new URL(discoveryUrl(value));
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${isLoopbackHost(url.hostname) ? "loopback" : url.hostname.toLowerCase()}:${port}`;
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const terminals = yield* TerminalManager.TerminalManager;
  const discovery = yield* PortScanner.PortDiscovery;
  const statePath = path.join(config.stateDir, HOSTING_STATE_FILE);
  const persistLock = yield* Semaphore.make(1);
  const leaseLocks = yield* SynchronizedRef.make(
    new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
  );
  const wakeups = yield* Queue.dropping<void>(1);

  const readState = Effect.gen(function* () {
    const raw = yield* fs.readFileString(statePath).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new PreviewHostingError({
                  operation: "read",
                  statePath,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeedSome(contents),
      }),
    );
    if (Option.isNone(raw)) return [] satisfies ReadonlyArray<PreviewHostingLease>;
    const decoded = yield* decodedState(raw.value).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewHostingError({
            operation: "decode",
            statePath,
            cause,
          }),
      ),
    );
    const invalidLease = decoded.leases.find(
      (lease) =>
        lease.id.trim().length === 0 ||
        lease.threadId.trim().length === 0 ||
        lease.terminalId.trim().length === 0 ||
        lease.command.trim().length === 0 ||
        !path.isAbsolute(lease.cwd) ||
        (lease.worktreePath !== null && !path.isAbsolute(lease.worktreePath)) ||
        normalizeLocalHttpUrl(lease.url) !== lease.url ||
        !Number.isFinite(Date.parse(lease.handedOffAt)) ||
        !Number.isFinite(Date.parse(lease.expiresAt)),
    );
    if (invalidLease !== undefined) {
      return yield* new PreviewHostingError({
        operation: "decode",
        statePath,
        threadId: invalidLease.threadId,
        url: invalidLease.url,
        detail: "Persisted preview lease contains invalid identity, path, URL, or expiry data.",
      });
    }
    return decoded.leases;
  });

  const startupErrorRef = yield* SynchronizedRef.make<PreviewHostingError | null>(null);
  const initialLeases = yield* readState.pipe(
    Effect.catch((error) =>
      SynchronizedRef.set(startupErrorRef, error).pipe(
        Effect.andThen(
          Effect.logWarning(
            "preview hosting is unavailable because its lease state could not be read",
            { statePath, error: error.message },
          ),
        ),
        Effect.as([] as ReadonlyArray<PreviewHostingLease>),
      ),
    ),
  );
  const leasesRef = yield* SynchronizedRef.make<ReadonlyArray<PreviewHostingLease>>(initialLeases);

  const persistState = (leases: ReadonlyArray<PreviewHostingLease>) =>
    writeFileStringAtomically({
      filePath: statePath,
      // Launch commands and environment overrides can contain credentials.
      mode: 0o600,
      contents: `${JSON.stringify({ version: STATE_VERSION, leases } satisfies PersistedPreviewHostingState)}\n`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewHostingError({
            operation: "persist",
            statePath,
            cause,
          }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const changeLeases = <A>(
    f: (
      current: ReadonlyArray<PreviewHostingLease>,
    ) => readonly [A, ReadonlyArray<PreviewHostingLease>],
    wakeWorker = true,
  ) =>
    persistLock.withPermit(
      Effect.gen(function* () {
        const current = yield* SynchronizedRef.get(leasesRef);
        const [result, next] = f(current);
        yield* persistState(next);
        yield* SynchronizedRef.set(leasesRef, next);
        if (wakeWorker) yield* Queue.offer(wakeups, undefined);
        return result;
      }),
    );

  const withLeaseLock = <A, E, R>(leaseId: string, effect: Effect.Effect<A, E, R>) => {
    const acquire = SynchronizedRef.modifyEffect(leaseLocks, (current) => {
      const existing = current.get(leaseId);
      if (existing) {
        const next = new Map(current);
        const entry = { ...existing, users: existing.users + 1 };
        next.set(leaseId, entry);
        return Effect.succeed([entry, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((created) => {
          const next = new Map(current);
          const entry = { semaphore: created, users: 1 };
          next.set(leaseId, entry);
          return [entry, next] as const;
        }),
      );
    });
    return Effect.acquireUseRelease(
      acquire,
      (entry) => entry.semaphore.withPermit(effect),
      ({ semaphore }) =>
        SynchronizedRef.update(leaseLocks, (current) => {
          const entry = current.get(leaseId);
          if (entry === undefined || entry.semaphore !== semaphore) return current;
          const next = new Map(current);
          if (entry.users === 1) next.delete(leaseId);
          else next.set(leaseId, { ...entry, users: entry.users - 1 });
          return next;
        }),
    );
  };

  const nowMillis = Effect.map(DateTime.now, (now) => DateTime.toEpochMillis(now));
  const findLease = (leaseId: string) =>
    SynchronizedRef.get(leasesRef).pipe(
      Effect.map((leases) => leases.find((lease) => lease.id === leaseId) ?? null),
    );

  const setLease = (lease: PreviewHostingLease, wakeWorker = true) =>
    changeLeases(
      (leases) => [undefined, leases.map((entry) => (entry.id === lease.id ? lease : entry))],
      wakeWorker,
    );

  const removeLease = (leaseId: string) =>
    changeLeases((leases) => [undefined, leases.filter((lease) => lease.id !== leaseId)]);

  const startupError = yield* SynchronizedRef.get(startupErrorRef);

  const makeReadinessError = (lease: PreviewHostingLease) =>
    new PreviewHostingError({
      operation: "ready",
      statePath,
      threadId: lease.threadId,
      url: lease.url,
    });

  const waitForReady = Effect.fn("PreviewHosting.waitForReady")(function* (
    lease: PreviewHostingLease,
  ) {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<DiscoveredLocalServer>();
        const listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => {
          const expectedUrl = discoveryUrl(lease.url);
          const match = servers.find((server) => {
            if (discoveryUrl(server.url) !== expectedUrl) return false;
            if (server.terminal === null) return false;
            return (
              server.terminal.threadId === lease.threadId &&
              server.terminal.terminalId === lease.terminalId
            );
          });
          return match ? Deferred.succeed(ready, match).pipe(Effect.asVoid) : Effect.void;
        };
        yield* discovery.subscribe({ configuredUrls: [lease.url], initialSnapshot: [] }, listener);
        yield* discovery.retain;
        const currentTime = yield* nowMillis;
        const remainingLeaseMs = Math.max(0, Date.parse(lease.expiresAt) - currentTime);
        const timeoutMs = Math.min(READY_TIMEOUT_MS, remainingLeaseMs);
        if (timeoutMs === 0) return Option.none<DiscoveredLocalServer>();
        return yield* Deferred.await(ready).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
      }),
    );
    if (Option.isNone(result)) return yield* makeReadinessError(lease);
    return result.value;
  });

  const terminalSummary = (lease: PreviewHostingLease) =>
    terminals.refreshMetadata.pipe(
      Effect.andThen(terminals.metadata),
      Effect.map(
        (summaries) =>
          summaries.find(
            (summary) =>
              summary.threadId === lease.threadId && summary.terminalId === lease.terminalId,
          ) ?? null,
      ),
    );

  const verifyLaunchOwnership = Effect.fn("PreviewHosting.verifyLaunchOwnership")(function* (
    lease: PreviewHostingLease,
  ) {
    const summary = yield* terminalSummary(lease);
    const servers = yield* discovery.scan([lease.url]);
    const server = servers.find((entry) => discoveryUrl(entry.url) === discoveryUrl(lease.url));
    if (server === undefined) return;

    const ownsRunningSubprocess = summary?.status === "running" && summary.hasRunningSubprocess;
    const serverOwner = server.terminal;
    const attributedToLease =
      serverOwner?.threadId === lease.threadId && serverOwner.terminalId === lease.terminalId;
    if (!ownsRunningSubprocess || !attributedToLease) {
      return yield* new PreviewHostingError({
        operation: "validate",
        statePath,
        threadId: lease.threadId,
        url: lease.url,
        detail: "Preview URL is already served by a process this preview terminal does not own.",
      });
    }
  });

  const openInput = (lease: PreviewHostingLease): TerminalOpenInput => ({
    threadId: lease.threadId,
    terminalId: lease.terminalId,
    cwd: lease.cwd,
    worktreePath: lease.worktreePath,
    ...(lease.env === undefined ? {} : { env: lease.env }),
    ...(lease.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: lease.providerInstanceId }),
  });

  const launchCommandIfNeeded = (lease: PreviewHostingLease) =>
    Effect.gen(function* () {
      const summary = yield* terminalSummary(lease);
      if (summary?.status === "running" && summary.hasRunningSubprocess) return;
      yield* terminals.open(openInput(lease));
      yield* terminals.write({
        threadId: lease.threadId,
        terminalId: lease.terminalId,
        data: lease.command.endsWith("\n") ? lease.command : `${lease.command}\n`,
      });
    });

  const closeOwnedTerminal = (lease: PreviewHostingLease) =>
    terminals.close({ threadId: lease.threadId, terminalId: lease.terminalId });

  const expireLocked = (lease: PreviewHostingLease) =>
    Effect.gen(function* () {
      const currentTime = yield* nowMillis;
      let latest = yield* findLease(lease.id);
      if (latest === null) return;
      if (Date.parse(latest.expiresAt) > currentTime && latest.status !== "expired") return;
      if (latest.status !== "expired") {
        latest = { ...latest, status: "expired" };
        yield* setLease(latest, false);
      }
      yield* closeOwnedTerminal(latest).pipe(
        Effect.tap(() => removeLease(latest!.id)),
        Effect.catch((error) =>
          Effect.logWarning("failed to close expired preview terminal", {
            threadId: latest!.threadId,
            terminalId: latest!.terminalId,
            error: error.message,
          }),
        ),
      );
    });

  const ensureLeaseReady = (leaseId: string) =>
    withLeaseLock(
      leaseId,
      Effect.gen(function* () {
        const lease = yield* findLease(leaseId);
        if (lease === null) return null;
        const currentTime = yield* nowMillis;
        if (lease.status === "expired" || Date.parse(lease.expiresAt) <= currentTime) {
          yield* expireLocked(lease);
          return null;
        }

        const startsHandoff = lease.status === "starting";
        yield* verifyLaunchOwnership(lease);
        yield* launchCommandIfNeeded(lease);
        yield* waitForReady(lease);
        const afterReady = yield* findLease(lease.id);
        const completedAt = yield* nowMillis;
        if (
          afterReady === null ||
          afterReady.status === "expired" ||
          Date.parse(afterReady.expiresAt) <= completedAt
        ) {
          if (afterReady !== null) yield* expireLocked(afterReady);
          return null;
        }
        const readyTerminal = yield* terminalSummary(lease);
        if (readyTerminal?.status !== "running" || !readyTerminal.hasRunningSubprocess) {
          return yield* makeReadinessError(lease);
        }
        const handedOffAt = startsHandoff ? completedAt : Date.parse(afterReady.handedOffAt);
        const active = {
          ...afterReady,
          ...(startsHandoff
            ? {
                handedOffAt: DateTime.formatIso(DateTime.makeUnsafe(handedOffAt)),
                expiresAt: DateTime.formatIso(
                  DateTime.makeUnsafe(handedOffAt + PREVIEW_HOSTING_LEASE_MS),
                ),
              }
            : {}),
          status: "active" as const,
        };
        yield* setLease(active);
        return active;
      }),
    );

  const cleanupFailedLaunch = (lease: PreviewHostingLease) =>
    withLeaseLock(
      lease.id,
      Effect.gen(function* () {
        const latest = yield* findLease(lease.id);
        // A concurrent launch may already have handed this reservation off.
        if (latest === null || latest.status === "active") return;
        const expired = { ...latest, status: "expired" as const };
        yield* SynchronizedRef.update(leasesRef, (leases) =>
          leases.map((entry) => (entry.id === expired.id ? expired : entry)),
        );
        yield* setLease(expired, false).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist failed preview lease cleanup state", {
              threadId: lease.threadId,
              terminalId: lease.terminalId,
              error: error.message,
            }),
          ),
        );
        yield* expireLocked(expired).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to clean up failed preview terminal", {
              threadId: lease.threadId,
              terminalId: lease.terminalId,
              error: error.message,
            }),
          ),
        );
        yield* Queue.offer(wakeups, undefined);
      }),
    );

  const containingWorktree = Effect.fn("PreviewHosting.containingWorktree")(function* (
    cwd: string,
  ) {
    let directory = path.resolve(cwd);
    while (true) {
      if (yield* fs.exists(path.join(directory, ".git"))) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  });

  const launchGate = yield* Semaphore.make(1);
  const launch: PreviewHosting["Service"]["launch"] = (requestedInput) =>
    Effect.gen(function* () {
      const worktreePath =
        requestedInput.worktreePath ??
        (path.isAbsolute(requestedInput.cwd)
          ? yield* containingWorktree(requestedInput.cwd).pipe(
              Effect.mapError(
                (cause) =>
                  new PreviewHostingError({
                    operation: "validate",
                    statePath,
                    threadId: requestedInput.threadId,
                    url: requestedInput.url,
                    cause,
                  }),
              ),
            )
          : null);
      const input = { ...requestedInput, worktreePath };
      const leaseForCleanup = yield* SynchronizedRef.make<PreviewHostingLease | null>(null);
      const operation = Effect.gen(function* () {
        const selected = yield* launchGate.withPermit(
          withWorkspaceLease(
            path.resolve(input.worktreePath ?? input.cwd),
            Effect.gen(function* () {
              if (startupError !== null) return yield* startupError;
              const normalizedUrl = normalizeLocalHttpUrl(input.url);
              if (normalizedUrl === null) {
                return yield* new PreviewHostingError({
                  operation: "validate",
                  statePath,
                  threadId: input.threadId,
                  url: input.url,
                  detail: "Preview leases require a valid local HTTP or HTTPS URL.",
                });
              }
              if (input.command.trim().length === 0 || input.cwd.trim().length === 0) {
                return yield* new PreviewHostingError({
                  operation: "validate",
                  statePath,
                  threadId: input.threadId,
                  url: normalizedUrl,
                  detail: "Preview command and working directory are required.",
                });
              }
              if (
                !path.isAbsolute(input.cwd) ||
                (input.worktreePath != null && !path.isAbsolute(input.worktreePath))
              ) {
                return yield* new PreviewHostingError({
                  operation: "validate",
                  statePath,
                  threadId: input.threadId,
                  url: normalizedUrl,
                  detail: "Preview working directory and worktree path must be absolute.",
                });
              }
              const cwd = path.resolve(input.cwd);
              const worktreePath =
                input.worktreePath == null ? null : path.resolve(input.worktreePath);

              const createdAtMillis = yield* nowMillis;
              const existing = yield* SynchronizedRef.get(leasesRef).pipe(
                Effect.map((leases) =>
                  leases
                    .filter((lease) => lease.status !== "expired")
                    .filter((lease) => Date.parse(lease.expiresAt) > createdAtMillis)
                    .toSorted((left, right) => right.handedOffAt.localeCompare(left.handedOffAt)),
                ),
              );
              const sameLease = existing.find(
                (lease) => lease.threadId === input.threadId && lease.url === normalizedUrl,
              );
              const portConflict = existing.find(
                (lease) => discoveryPortKey(lease.url) === discoveryPortKey(normalizedUrl),
              );
              if (sameLease !== undefined) {
                if (portConflict !== undefined && portConflict.id !== sameLease.id) {
                  return yield* new PreviewHostingError({
                    operation: "validate",
                    statePath,
                    threadId: input.threadId,
                    url: normalizedUrl,
                    detail: "A live preview lease already owns this discovery port.",
                  });
                }
                if (
                  sameLease.command !== input.command ||
                  sameLease.cwd !== cwd ||
                  sameLease.worktreePath !== worktreePath ||
                  sameLease.providerInstanceId !== input.providerInstanceId ||
                  !sameEnvironment(sameLease.env, input.env)
                ) {
                  return yield* new PreviewHostingError({
                    operation: "validate",
                    statePath,
                    threadId: input.threadId,
                    url: normalizedUrl,
                    detail:
                      "A live preview lease already owns this URL with a different launch command.",
                  });
                }
                if (sameLease.status === "starting") {
                  yield* SynchronizedRef.set(leaseForCleanup, sameLease);
                }
                return { lease: sameLease } as const;
              }
              if (portConflict !== undefined) {
                return yield* new PreviewHostingError({
                  operation: "validate",
                  statePath,
                  threadId: input.threadId,
                  url: normalizedUrl,
                  detail: `A live preview lease already owns discovery port ${new URL(normalizedUrl).port || (new URL(normalizedUrl).protocol === "https:" ? "443" : "80")}.`,
                });
              }

              const id = NodeCrypto.randomUUID();
              const handedOffAt = DateTime.formatIso(DateTime.makeUnsafe(createdAtMillis));
              const lease: PreviewHostingLease = {
                id,
                threadId: input.threadId,
                terminalId: `preview-${id}`,
                command: input.command,
                cwd,
                worktreePath,
                ...(input.env === undefined ? {} : { env: input.env }),
                ...(input.providerInstanceId === undefined
                  ? {}
                  : { providerInstanceId: input.providerInstanceId }),
                url: normalizedUrl,
                handedOffAt,
                expiresAt: DateTime.formatIso(
                  DateTime.makeUnsafe(createdAtMillis + PREVIEW_HOSTING_LEASE_MS),
                ),
                status: "starting",
              };
              yield* Effect.uninterruptible(
                SynchronizedRef.set(leaseForCleanup, lease).pipe(
                  Effect.andThen(changeLeases((leases) => [undefined, [...leases, lease]])),
                ),
              );
              return { lease } as const;
            }),
          ),
        );

        // The durable reservation is visible to cleanup before the workspace lock
        // is released. TerminalManager.open takes the same lock itself, so readiness
        // must run after this short reservation section rather than inside it.
        const ensureReady = ensureLeaseReady(selected.lease.id);
        const started = yield* ensureReady;
        if (started === null) {
          return yield* new PreviewHostingError({
            operation: "ready",
            statePath,
            threadId: input.threadId,
            url: selected.lease.url,
          });
        }
        return started;
      });
      return yield* operation.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? SynchronizedRef.get(leaseForCleanup).pipe(
                Effect.flatMap((lease) =>
                  lease === null ? Effect.void : cleanupFailedLaunch(lease),
                ),
              )
            : Effect.void,
        ),
      );
    });

  const recover: PreviewHosting["Service"]["recover"] = (input) =>
    Effect.gen(function* () {
      if (startupError !== null) return yield* startupError;
      const normalizedUrl = normalizeLocalHttpUrl(input.url);
      if (normalizedUrl === null) return null;
      const leases = yield* SynchronizedRef.get(leasesRef);
      const currentTime = yield* nowMillis;
      const lease = leases.find(
        (entry) =>
          entry.threadId === input.threadId &&
          entry.id === input.leaseId &&
          entry.url === normalizedUrl,
      );
      if (lease === undefined) return null;
      if (lease.status === "expired" || Date.parse(lease.expiresAt) <= currentTime) {
        yield* withLeaseLock(lease.id, expireLocked(lease));
        return null;
      }
      return yield* ensureLeaseReady(lease.id);
    });

  const list: PreviewHosting["Service"]["list"] = (threadId) =>
    Effect.gen(function* () {
      if (startupError !== null) return yield* startupError;
      const currentTime = yield* nowMillis;
      const leases = yield* SynchronizedRef.get(leasesRef);
      return leases
        .filter(
          (lease) =>
            lease.status !== "expired" &&
            Date.parse(lease.expiresAt) > currentTime &&
            (threadId === undefined || lease.threadId === threadId),
        )
        .toSorted((left, right) => left.expiresAt.localeCompare(right.expiresAt));
    });

  const ownsTerminal: PreviewHosting["Service"]["ownsTerminal"] = (threadId, terminalId) =>
    Effect.gen(function* () {
      if (startupError !== null) return yield* startupError;
      const currentTime = yield* nowMillis;
      const leases = yield* SynchronizedRef.get(leasesRef);
      return leases.some(
        (lease) =>
          lease.threadId === threadId &&
          lease.terminalId === terminalId &&
          lease.status !== "expired" &&
          Date.parse(lease.expiresAt) > currentTime,
      );
    });

  const removeThread: PreviewHosting["Service"]["removeThread"] = (threadId) =>
    launchGate.withPermit(
      Effect.gen(function* () {
        if (startupError !== null) return yield* startupError;
        const owned = (yield* SynchronizedRef.get(leasesRef)).filter(
          (lease) => lease.threadId === threadId,
        );
        const results = yield* Effect.forEach(
          owned,
          (lease) =>
            withLeaseLock(
              lease.id,
              Effect.gen(function* () {
                const latest = yield* findLease(lease.id);
                if (latest === null || latest.threadId !== threadId) return;
                const expired =
                  latest.status === "expired" ? latest : { ...latest, status: "expired" as const };
                if (expired !== latest) yield* setLease(expired);
                yield* closeOwnedTerminal(expired);
                yield* removeLease(expired.id);
              }),
            ).pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        const failure = results.find((result) => result._tag === "Failure");
        if (failure?._tag === "Failure") return yield* failure.failure;
      }),
    );

  const protectedWorkspacePaths: PreviewHosting["Service"]["protectedWorkspacePaths"] = () =>
    Effect.gen(function* () {
      if (startupError !== null) return yield* startupError;
      return [
        ...new Set(
          (yield* SynchronizedRef.get(leasesRef)).flatMap((lease) => [
            lease.cwd,
            ...(lease.worktreePath === null ? [] : [lease.worktreePath]),
          ]),
        ),
      ];
    });

  const expireDueLeases = Effect.fn("PreviewHosting.expireDueLeases")(function* () {
    const currentTime = yield* nowMillis;
    const due = (yield* SynchronizedRef.get(leasesRef)).filter(
      (lease) => lease.status === "expired" || Date.parse(lease.expiresAt) <= currentTime,
    );
    yield* Effect.forEach(
      due,
      (lease) =>
        withLeaseLock(lease.id, expireLocked(lease)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to expire preview lease; cleanup will retry", {
              threadId: lease.threadId,
              terminalId: lease.terminalId,
              error: error.message,
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
    return currentTime;
  });

  const expiryWorker = Effect.forever(
    Effect.gen(function* () {
      const checkedAt = yield* expireDueLeases();
      const now = yield* nowMillis;
      const leases = yield* SynchronizedRef.get(leasesRef);
      const activeExpiry = leases
        // Deadlines crossed while cleanup was running need another pass immediately.
        .filter((lease) => lease.status !== "expired" && Date.parse(lease.expiresAt) > checkedAt)
        .map((lease) => Date.parse(lease.expiresAt));
      const failedCleanupPending = leases.some(
        (lease) => lease.status === "expired" || Date.parse(lease.expiresAt) <= now,
      );
      const activeDelayMs =
        activeExpiry.length === 0 ? undefined : Math.max(0, Math.min(...activeExpiry) - now);
      const delayMs = failedCleanupPending
        ? Math.min(EXPIRED_TERMINAL_RETRY_MS, activeDelayMs ?? EXPIRED_TERMINAL_RETRY_MS)
        : activeDelayMs;
      if (delayMs === undefined) {
        yield* Queue.take(wakeups);
      } else {
        yield* Effect.race(Effect.sleep(Duration.millis(delayMs)), Queue.take(wakeups));
      }
    }),
  );

  yield* expireDueLeases();
  yield* Effect.forkScoped(expiryWorker);

  return PreviewHosting.of({
    launch,
    recover,
    list,
    ownsTerminal,
    removeThread,
    protectedWorkspacePaths,
  });
});

export const layer = Layer.effect(PreviewHosting, make);
