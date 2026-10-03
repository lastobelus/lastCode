/**
 * In-memory PreviewManager implementation.
 *
 * Sessions are keyed by `(threadId, tabId)`; a single thread can host
 * multiple tabs (browser-style). `open` always creates a new tab — tab
 * lifecycle is owned by the renderer.
 *
 * Events are published via Effect's `PubSub`, so subscriber failures are
 * isolated from the publishing call (a closed WS subscriber queue cannot
 * fail an in-progress `navigate()`).
 */
import {
  type PreviewCloseInput,
  type PreviewClaimRecoveryInput,
  type PreviewEvent,
  type PreviewError,
  PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  type PreviewRecoveryClaim,
  PreviewRecoveryStorageError,
  type PreviewResizeInput,
  FILL_PREVIEW_VIEWPORT,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import {
  isPreviewUrlNormalizationError,
  newPreviewTabId,
  normalizePreviewUrl,
} from "@t3tools/shared/preview";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CommandId, MessageId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly navigate: (
      input: PreviewNavigateInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly reportStatus: (input: PreviewReportStatusInput) => Effect.Effect<void, PreviewError>;
    readonly claimRecovery: (
      input: PreviewClaimRecoveryInput,
    ) => Effect.Effect<PreviewRecoveryClaim, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly events: Stream.Stream<PreviewEvent>;
    readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
  }
>()("t3/preview/Manager/PreviewManager") {}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
}

interface ManagerState {
  /** All sessions across every thread, keyed by `${threadId}\u0000${tabId}`. */
  readonly sessions: ReadonlyMap<string, PreviewSessionState>;
  /** Global monotonic revision establishing list/event ordering. */
  readonly revision: number;
}

const initialState: ManagerState = { sessions: new Map(), revision: 0 };

const RECOVERY_CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;
const RecoveryClaimRecord = Schema.Struct({
  threadId: Schema.String,
  url: Schema.String,
  commandId: CommandId,
  messageId: MessageId,
  createdAt: Schema.Number,
  tabIds: Schema.Array(Schema.String),
});
const RecoveryClaimFile = Schema.Array(RecoveryClaimRecord);
type RecoveryClaimRecord = typeof RecoveryClaimRecord.Type;
const RecoveryClaimFileJson = Schema.fromJsonString(RecoveryClaimFile);
const decodeRecoveryClaimFile = Schema.decodeUnknownEffect(RecoveryClaimFileJson);
const encodeRecoveryClaimFile = Schema.encodeSync(RecoveryClaimFileJson);

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const compositeKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;
const recoveryClaimKey = (threadId: string, url: string): string => JSON.stringify([threadId, url]);

const sessionsForThread = (
  state: ManagerState,
  threadId: string,
): ReadonlyArray<PreviewSessionState> => {
  const out: PreviewSessionState[] = [];
  for (const session of state.sessions.values()) {
    if (session.threadId === threadId) out.push(session);
  }
  return out;
};

const normalizeUrl = (rawUrl: string): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) => {
      if (isPreviewUrlNormalizationError(cause)) {
        return new PreviewInvalidUrlError({
          inputLength: cause.inputLength,
          reason: cause.reason,
          protocol: cause.protocol,
          cause,
        });
      }

      return new PreviewInvalidUrlError({
        inputLength: rawUrl.length,
        reason: "unexpected",
        cause,
      });
    },
  });

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const buildLoadingSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly viewport: PreviewViewportSetting;
  readonly profileId?: string | undefined;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Loading", url: input.url, title: input.title },
  canGoBack: false,
  canGoForward: false,
  viewport: input.viewport,
  ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  updatedAt: input.updatedAt,
});

const buildIdleSnapshot = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly viewport: PreviewViewportSetting;
  readonly profileId?: string | undefined;
  readonly updatedAt: string;
}): PreviewSessionSnapshot => ({
  threadId: input.threadId,
  tabId: input.tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport: input.viewport,
  ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  updatedAt: input.updatedAt,
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* PreviewManagerMake() {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recoveryClaimsPath = path.join(serverConfig.stateDir, "preview-recovery-claims.json");
  const loadedRecoveryClaims = yield* fileSystem.exists(recoveryClaimsPath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFileString(recoveryClaimsPath).pipe(
            Effect.flatMap(decodeRecoveryClaimFile),
            Effect.map(
              (records) =>
                new Map(
                  records.map((record) => [recoveryClaimKey(record.threadId, record.url), record]),
                ),
            ),
          )
        : Effect.succeed(new Map<string, RecoveryClaimRecord>()),
    ),
    Effect.map((claims) => ({ claims, loadError: null as unknown | null })),
    Effect.catch((cause) =>
      Effect.succeed({ claims: new Map<string, RecoveryClaimRecord>(), loadError: cause }),
    ),
  );
  const recoveryClaimsLoadError = loadedRecoveryClaims.loadError;
  const recoveryClaimsRef = yield* SynchronizedRef.make(loadedRecoveryClaims.claims);
  const serverEpoch = NodeCrypto.randomUUID();
  const stateRef = yield* SynchronizedRef.make<ManagerState>(initialState);
  // Unbounded PubSub is fine here — events are tiny and we don't want to
  // block publishers if a subscriber is slow. WS clients backpressure on
  // their own queues downstream.
  const eventsPubSub = yield* PubSub.unbounded<PreviewEvent>();
  const events: Stream.Stream<PreviewEvent> = Stream.fromPubSub(eventsPubSub);

  /**
   * Atomic read-modify-write over the session for `(threadId, tabId)`. The
   * mutator runs under the SynchronizedRef so concurrent writers cannot
   * interleave. Lookup failures travel through the modify result so both
   * branches yield the same `[A, S]` shape `modifyEffect` requires.
   *
   * The event is published INSIDE the lock so observers see events in the
   * same order as the underlying state transitions. Publishing an unbounded
   * PubSub is non-blocking, so this is cheap.
   */
  const mutateExistingSession = <R, E>(
    threadId: string,
    tabId: string,
    mutator: (
      session: PreviewSessionState,
    ) => Effect.Effect<{ next: PreviewSessionState; emit: PreviewEventDraft | null; result: R }, E>,
  ): Effect.Effect<R, E | PreviewSessionLookupError> => {
    type ModifyResult =
      | { kind: "fail"; error: PreviewSessionLookupError }
      | { kind: "ok"; result: R };

    return SynchronizedRef.modifyEffect(stateRef, (state) => {
      const session = state.sessions.get(compositeKey(threadId, tabId));
      if (!session) {
        return Effect.succeed([
          { kind: "fail", error: new PreviewSessionLookupError({ threadId, tabId }) },
          state,
        ] as readonly [ModifyResult, ManagerState]);
      }
      return mutator(session).pipe(
        Effect.flatMap(
          Effect.fn("PreviewManager.commitMutation")(function* ({ next, emit, result }) {
            const revision = emit ? state.revision + 1 : state.revision;
            if (emit) {
              yield* PubSub.publish(eventsPubSub, {
                ...emit,
                revision,
                serverEpoch,
              } as PreviewEvent);
            }
            const sessions = new Map(state.sessions);
            sessions.set(compositeKey(threadId, tabId), next);
            return [{ kind: "ok", result } as ModifyResult, { sessions, revision }] as readonly [
              ModifyResult,
              ManagerState,
            ];
          }),
        ),
      );
    }).pipe(
      Effect.flatMap((modify) =>
        modify.kind === "fail" ? Effect.fail(modify.error) : Effect.succeed(modify.result),
      ),
    );
  };

  const open: PreviewManager["Service"]["open"] = Effect.fn("PreviewManager.open")(
    function* (input) {
      const tabId = newPreviewTabId();
      const updatedAt = yield* currentIsoTimestamp;
      // Clients with a configured default send the viewport up front so the
      // session is born at the right size; older clients omit it and keep the
      // historical fill-panel behaviour.
      const viewport = input.viewport ?? FILL_PREVIEW_VIEWPORT;
      const snapshot = input.url
        ? buildLoadingSnapshot({
            threadId: input.threadId,
            tabId,
            url: yield* normalizeUrl(input.url),
            title: "",
            viewport,
            profileId: input.profileId,
            updatedAt,
          })
        : buildIdleSnapshot({
            threadId: input.threadId,
            tabId,
            viewport,
            profileId: input.profileId,
            updatedAt,
          });
      yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          const revision = state.revision + 1;
          const sessions = new Map(state.sessions);
          sessions.set(compositeKey(input.threadId, tabId), {
            threadId: input.threadId,
            tabId,
            snapshot,
          });
          yield* PubSub.publish(eventsPubSub, {
            type: "opened",
            threadId: input.threadId,
            tabId,
            createdAt: snapshot.updatedAt,
            serverEpoch,
            revision,
            snapshot,
          });
          return [snapshot, { sessions, revision }] as const;
        }),
      );
      return snapshot;
    },
  );

  const navigate: PreviewManager["Service"]["navigate"] = Effect.fn("PreviewManager.navigate")(
    function* (input) {
      const url = yield* normalizeUrl(input.url);
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.navigateSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const previousTitle =
            session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
          const resolvedTitle = input.resolvedTitle ?? previousTitle;
          const snapshot: PreviewSessionSnapshot = {
            threadId: session.threadId,
            tabId: session.tabId,
            navStatus: { _tag: "Success", url, title: resolvedTitle },
            canGoBack: session.snapshot.canGoBack,
            canGoForward: session.snapshot.canGoForward,
            viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
            ...(session.snapshot.profileId === undefined
              ? {}
              : { profileId: session.snapshot.profileId }),
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "navigated",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const reportStatus: PreviewManager["Service"]["reportStatus"] = Effect.fn(
    "PreviewManager.reportStatus",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.reportSessionStatus")(function* (session) {
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          threadId: session.threadId,
          tabId: session.tabId,
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
          ...(session.snapshot.profileId === undefined
            ? {}
            : { profileId: session.snapshot.profileId }),
          updatedAt,
        };
        const emit: PreviewEventDraft =
          input.navStatus._tag === "LoadFailed"
            ? {
                type: "failed",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                url: input.navStatus.url,
                title: input.navStatus.title,
                code: input.navStatus.code,
                description: input.navStatus.description,
              }
            : {
                type: "navigated",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                snapshot,
              };
        return {
          next: { ...session, snapshot },
          emit,
          result: undefined as void,
        };
      }),
    );
    if (input.navStatus._tag === "Success" && recoveryClaimsLoadError === null) {
      yield* SynchronizedRef.modifyEffect(recoveryClaimsRef, (claims) => {
        const remaining = new Map(claims);
        for (const [key, claim] of claims) {
          if (claim.threadId === input.threadId && claim.tabIds.includes(input.tabId)) {
            remaining.delete(key);
          }
        }
        if (remaining.size === claims.size) return Effect.succeed([undefined, claims] as const);
        return persistRecoveryClaims(remaining).pipe(Effect.as([undefined, remaining] as const));
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "Could not release preview recovery identities after successful navigation.",
            {
              cause: String(cause),
            },
          ),
        ),
      );
    }
  });

  const claimRecovery: PreviewManager["Service"]["claimRecovery"] = Effect.fn(
    "PreviewManager.claimRecovery",
  )(function* (input) {
    if (recoveryClaimsLoadError !== null) {
      return yield* new PreviewRecoveryStorageError({ cause: recoveryClaimsLoadError });
    }
    const key = recoveryClaimKey(input.threadId, input.url);
    const now = yield* Clock.currentTimeMillis;
    return yield* SynchronizedRef.modifyEffect(recoveryClaimsRef, (claims) => {
      const retained = new Map(
        [...claims].filter(([, claim]) => now - claim.createdAt <= RECOVERY_CLAIM_TTL_MS),
      );
      const current = retained.get(key);
      if (current) {
        const next = current.tabIds.includes(input.tabId)
          ? current
          : { ...current, tabIds: [...current.tabIds, input.tabId] };
        retained.set(key, next);
        if (next === current && retained.size === claims.size) {
          return Effect.succeed([
            { commandId: next.commandId, messageId: next.messageId },
            claims,
          ] as const);
        }
        return persistRecoveryClaims(retained).pipe(
          Effect.as([{ commandId: next.commandId, messageId: next.messageId }, retained] as const),
        );
      }
      const next: RecoveryClaimRecord = {
        threadId: input.threadId,
        url: input.url,
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        createdAt: now,
        tabIds: [input.tabId],
      };
      retained.set(key, next);
      return persistRecoveryClaims(retained).pipe(
        Effect.as([{ commandId: next.commandId, messageId: next.messageId }, retained] as const),
      );
    });
  });

  const persistRecoveryClaims = (claims: ReadonlyMap<string, RecoveryClaimRecord>) =>
    writeFileStringAtomically({
      filePath: recoveryClaimsPath,
      contents: encodeRecoveryClaimFile([...claims.values()]),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new PreviewRecoveryStorageError({ cause })),
    );

  const resize: PreviewManager["Service"]["resize"] = Effect.fn("PreviewManager.resize")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.resizeSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            viewport: input.viewport,
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "resized",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const refresh: PreviewManager["Service"]["refresh"] = Effect.fn("PreviewManager.refresh")(
    function* (input) {
      // Verify the session exists; the desktop bridge handles the actual reload
      // and will report progress back via `reportStatus`. No event emitted.
      yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, result: undefined as void }),
      );
    },
  );

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const createdAt = yield* currentIsoTimestamp;
      yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        const eventsToEmit: PreviewEvent[] = [];
        const sessions = new Map(state.sessions);
        const targets = input.tabId
          ? [state.sessions.get(compositeKey(input.threadId, input.tabId))].filter(
              (entry): entry is PreviewSessionState => entry !== undefined,
            )
          : sessionsForThread(state, input.threadId);
        let revision = state.revision;
        for (const target of targets) {
          revision += 1;
          sessions.delete(compositeKey(target.threadId, target.tabId));
          eventsToEmit.push({
            type: "closed",
            threadId: target.threadId,
            tabId: target.tabId,
            createdAt,
            serverEpoch,
            revision,
          });
        }
        if (eventsToEmit.length === 0) {
          return Effect.succeed([undefined, state] as const);
        }
        return Effect.as(
          Effect.forEach(eventsToEmit, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          }),
          [undefined, { sessions, revision }] as const,
        );
      });
    },
  );

  const list: PreviewManager["Service"]["list"] = Effect.fn("PreviewManager.list")(
    function* (input) {
      return yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state): PreviewListResult => ({
          sessions: sessionsForThread(state, input.threadId)
            .map((s) => s.snapshot)
            .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
          serverEpoch,
          revision: state.revision,
        })),
      );
    },
  );

  return PreviewManager.of({
    open,
    navigate,
    reportStatus,
    claimRecovery,
    resize,
    refresh,
    close,
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
