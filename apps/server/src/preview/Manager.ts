import {
  type PreviewCloseInput,
  type PreviewClaimRecoveryInput,
  type PreviewEvent,
  type PreviewError,
  PreviewInvalidUrlError,
  PreviewNativeCloseError,
  PreviewNativeCreateError,
  PreviewProfileHostError,
  isBuiltInBrowserProfileId,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewOpenInput,
  type PreviewReportStatusInput,
  type PreviewRecoveryClaim,
  PreviewRecoveryStorageError,
  PreviewSessionStorageError,
  type PreviewResizeInput,
  type PreviewAdjustInput,
  FILL_PREVIEW_VIEWPORT,
  PreviewSessionLookupError,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";
import {
  isPreviewUrlNormalizationError,
  newPreviewTabId,
  normalizePreviewUrl,
} from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { PreviewControlRequiredError } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CommandId, MessageId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly open: (
      input: PreviewOpenInput & {
        readonly automationOwner?: string;
        /** Trusted agent selection of environment hosting, even with local native IPC. */
        readonly environmentHosted?: boolean;
        /** Trusted native creation, unavailable on public open inputs. */
        readonly desktopPopup?: {
          readonly popupId: string;
          /** Waits for the actual native close before discarding its ownership/session. */
          readonly close?: () => Effect.Effect<void, PreviewError>;
        };
        /** Creates an independent native page before any subscriber sees the tab. */
        readonly createDesktopRoot?: (
          snapshot: PreviewSessionSnapshot,
        ) => Effect.Effect<NativeRoot, PreviewError>;
        /** Runs before the `opened` event publishes, so subscribers find state keyed by the tab. */
        readonly beforePublish?: (snapshot: PreviewSessionSnapshot) => void;
      },
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly restoreDesktopRoot: (
      input: PreviewCloseInput & {
        readonly tabId: string;
        readonly create: (
          snapshot: PreviewSessionSnapshot,
        ) => Effect.Effect<NativeRoot, PreviewError>;
      },
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly reportStatus: (
      input: PreviewReportStatusInput & { readonly serverControlled?: boolean },
    ) => Effect.Effect<void, PreviewError>;
    /** Records that a server tab runs headless. It stays headless until it closes. */
    readonly markHeadless: (
      input: PreviewCloseInput & { readonly tabId: string },
    ) => Effect.Effect<void, PreviewError>;
    readonly getHostedOrigins: (input: {
      readonly threadId: string;
      readonly tabId: string;
    }) => Effect.Effect<ReadonlyMap<string, string>>;
    /** Records only origins verified by a successful managed navigation preparation. */
    readonly rememberHostedOrigin: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly browserUrl: string;
      readonly localUrl: string;
    }) => Effect.Effect<void, PreviewSessionLookupError | PreviewSessionStorageError>;
    readonly requestReveal: (
      input: PreviewCloseInput & { readonly tabId: string; readonly force: boolean },
    ) => Effect.Effect<void, PreviewError>;
    readonly claimRecovery: (
      input: PreviewClaimRecoveryInput,
    ) => Effect.Effect<PreviewRecoveryClaim, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly adjust: (
      input: PreviewAdjustInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    /** Trusted native destruction notification; never exposed on public close inputs. */
    readonly nativeClosedConfirmed: (
      input: PreviewCloseInput & { readonly tabId: string },
    ) => Effect.Effect<void, PreviewSessionStorageError>;
    readonly nativeDormantConfirmed: (
      input: PreviewCloseInput & { readonly tabId: string },
    ) => Effect.Effect<void, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly events: Stream.Stream<PreviewEvent>;
    readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
  }
>()("t3/preview/Manager/PreviewManager") {}

interface NativeRoot {
  readonly rootId: string;
  readonly close: () => Effect.Effect<void, PreviewError>;
  readonly publish: () => Effect.Effect<void, PreviewError>;
}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
  readonly hostedOrigins?: ReadonlyArray<readonly [string, string]>;
}

interface ManagerState {
  readonly sessions: ReadonlyMap<string, PreviewSessionState>;
  readonly revision: number;
}

const MAX_SESSION_FILE_BYTES = 4 * 1024 * 1024;
const PreviewSessionFileJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Array(
      Schema.Struct({
        ...PreviewSessionSnapshot.fields,
        hostedOrigins: Schema.optional(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
      }),
    ),
  }),
);
const decodePreviewSessionFile = Schema.decodeUnknownEffect(PreviewSessionFileJson);
const encodePreviewSessionFile = Schema.encodeEffect(PreviewSessionFileJson);
const isPreviewSessionStorageError = Schema.is(PreviewSessionStorageError);

/** Native windows and browser history cannot survive an environment restart. */
function dormantSnapshot(snapshot: PreviewSessionSnapshot): PreviewSessionSnapshot {
  const {
    desktopRootId: _root,
    desktopPopupId: _popup,
    revealRequest: _reveal,
    ...retained
  } = snapshot;
  return {
    ...retained,
    navStatus:
      snapshot.navStatus._tag === "Idle"
        ? snapshot.navStatus
        : {
            _tag: "Loading",
            url: stripPreviewBootstrapTokenFromUrl(new URL(snapshot.navStatus.url)).href,
            title: snapshot.navStatus.title,
          },
    canGoBack: false,
    canGoForward: false,
    ...(snapshot.backingPage === "desktop-popup" ? { backingPage: "desktop" as const } : {}),
  };
}

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

/** @public */
export const make = Effect.gen(function* PreviewManagerMake() {
  const crypto = yield* Crypto.Crypto;
  const serverEpoch = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessionsPath = path.join(serverConfig.stateDir, "preview-sessions.json");
  const loadedSessions = yield* Effect.gen(function* () {
    if (!(yield* fileSystem.exists(sessionsPath))) return new Map<string, PreviewSessionState>();
    const info = yield* fileSystem.stat(sessionsPath);
    if (info.size > MAX_SESSION_FILE_BYTES) {
      return yield* new PreviewSessionStorageError({
        cause: new Error("Preview session record exceeds its size limit."),
      });
    }
    const contents = yield* fileSystem.readFileString(sessionsPath);
    const decoded = yield* decodePreviewSessionFile(contents);
    return yield* Effect.try(() => {
      const sessions = new Map<string, PreviewSessionState>();
      for (const { hostedOrigins, ...saved } of decoded.sessions) {
        const snapshot = dormantSnapshot(saved);
        const key = compositeKey(snapshot.threadId, snapshot.tabId);
        if (sessions.has(key)) throw new Error("Duplicate retained preview tab identity.");
        sessions.set(key, {
          threadId: snapshot.threadId,
          tabId: snapshot.tabId,
          snapshot,
          ...(hostedOrigins === undefined ? {} : { hostedOrigins }),
        });
      }
      return sessions;
    });
  }).pipe(
    Effect.mapError((cause) =>
      isPreviewSessionStorageError(cause) ? cause : new PreviewSessionStorageError({ cause }),
    ),
    Effect.matchEffect({
      onSuccess: (sessions) => Effect.succeed({ sessions, loadError: null }),
      onFailure: Effect.fn("PreviewManager.quarantineSessions")(function* (loadError) {
        const sessions = new Map<string, PreviewSessionState>();
        const backupPath = `${sessionsPath}.unreadable-${serverEpoch}`;
        const quarantineError = yield* fileSystem.rename(sessionsPath, backupPath).pipe(
          Effect.match({
            onSuccess: () => null,
            onFailure: (cause) => new PreviewSessionStorageError({ cause }),
          }),
        );
        if (quarantineError !== null) return { sessions, loadError: quarantineError };
        yield* Effect.logWarning(
          "Saved preview sessions could not be restored; the unreadable file was preserved in a backup.",
          { sessionsPath, backupPath, error: loadError.message },
        );
        return { sessions, loadError: null };
      }),
    }),
  );
  const sessionsLoadError = loadedSessions.loadError;
  if (sessionsLoadError !== null) {
    yield* Effect.logWarning(
      "Saved preview sessions could not be restored or backed up; session changes are disabled to preserve the file.",
      { sessionsPath, error: sessionsLoadError.message },
    );
  }
  const persistSessions = Effect.fn("PreviewManager.persistSessions")(
    function* (sessions: ReadonlyMap<string, PreviewSessionState>) {
      // Preserve unreadable state for repair rather than replacing it with a new history.
      if (sessionsLoadError !== null) return yield* sessionsLoadError;
      const retained = yield* Effect.try(() =>
        [...sessions.values()].map((session) => ({
          ...dormantSnapshot(session.snapshot),
          ...(session.hostedOrigins === undefined ? {} : { hostedOrigins: session.hostedOrigins }),
        })),
      );
      const contents = yield* encodePreviewSessionFile({ version: 1, sessions: retained });
      if (new TextEncoder().encode(contents).byteLength > MAX_SESSION_FILE_BYTES) {
        return yield* new PreviewSessionStorageError({
          cause: new Error("Preview session record exceeds its size limit."),
        });
      }
      yield* writeFileStringAtomically({ filePath: sessionsPath, contents, mode: 0o600 }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    },
    Effect.mapError((cause) =>
      isPreviewSessionStorageError(cause) ? cause : new PreviewSessionStorageError({ cause }),
    ),
  );
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
  const stateRef = yield* SynchronizedRef.make<ManagerState>({
    sessions: loadedSessions.sessions,
    revision: 0,
  });
  const nativeCloseGuards = new Map<string, () => Effect.Effect<void, PreviewError>>();
  const eventsPubSub = yield* PubSub.unbounded<PreviewEvent>();
  const events: Stream.Stream<PreviewEvent> = Stream.fromPubSub(eventsPubSub);

  /** Publish inside the lock to preserve state-transition order. */
  const mutateExistingSession = <R, E>(
    threadId: string,
    tabId: string,
    mutator: (
      session: PreviewSessionState,
    ) => Effect.Effect<{ next: PreviewSessionState; emit: PreviewEventDraft | null; result: R }, E>,
  ): Effect.Effect<R, E | PreviewSessionLookupError | PreviewSessionStorageError> => {
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
            const sessions = new Map(state.sessions);
            sessions.set(compositeKey(threadId, tabId), next);
            if (next !== session) yield* persistSessions(sessions);
            if (emit) {
              yield* PubSub.publish(eventsPubSub, {
                ...emit,
                revision,
                serverEpoch,
              } as PreviewEvent);
            }
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

  const getHostedOrigins: PreviewManager["Service"]["getHostedOrigins"] = Effect.fn(
    "PreviewManager.getHostedOrigins",
  )(function* (input) {
    const state = yield* SynchronizedRef.get(stateRef);
    return new Map(state.sessions.get(compositeKey(input.threadId, input.tabId))?.hostedOrigins);
  });

  const rememberHostedOrigin: PreviewManager["Service"]["rememberHostedOrigin"] = Effect.fn(
    "PreviewManager.rememberHostedOrigin",
  )(function* (input) {
    const [browserOrigin, localOrigin] = yield* Effect.try({
      try: () => [new URL(input.browserUrl).origin, new URL(input.localUrl).origin] as const,
      catch: (cause) => new PreviewSessionStorageError({ cause }),
    });
    yield* mutateExistingSession(input.threadId, input.tabId, (session) => {
      const origins = new Map(session.hostedOrigins);
      if (origins.get(browserOrigin) === localOrigin)
        return Effect.succeed({ next: session, emit: null, result: undefined });
      origins.set(browserOrigin, localOrigin);
      return Effect.succeed({
        next: { ...session, hostedOrigins: [...origins] },
        emit: null,
        result: undefined,
      });
    });
  });

  const open: PreviewManager["Service"]["open"] = Effect.fn("PreviewManager.open")(
    function* (input) {
      if (sessionsLoadError !== null) return yield* sessionsLoadError;
      const environmentHosted = input.environmentHosted || input.browserHost === "environment";
      if (
        environmentHosted &&
        input.profileId !== undefined &&
        !isBuiltInBrowserProfileId(input.profileId)
      ) {
        return yield* new PreviewProfileHostError({ profileId: input.profileId });
      }
      const runtime = environmentHosted ? "server" : input.runtime;
      // Choose before publishing: renderers and automation must create the same page.
      // An unavailable selected desktop fails attachment; it never becomes a headless tab.
      const desktopHostId = environmentHosted
        ? undefined
        : (input.desktopHostId ??
          (runtime === "server" &&
          serverConfig.desktopBrowserFd !== undefined &&
          serverConfig.desktopBrowserControlFd !== undefined
            ? "local"
            : undefined));
      // Persisted client surfaces must not bind to a different tab after a server restart.
      const tabId = `${newPreviewTabId()}_${serverEpoch}`;
      const updatedAt = yield* currentIsoTimestamp;
      const createDesktopRoot =
        runtime === "server" &&
        desktopHostId !== undefined &&
        input.automationOwner !== undefined &&
        input.desktopPopup === undefined
          ? input.createDesktopRoot
          : undefined;
      let snapshot: PreviewSessionSnapshot = {
        threadId: input.threadId,
        tabId,
        navStatus: input.url
          ? { _tag: "Loading", url: yield* normalizeUrl(input.url), title: "" }
          : { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        viewport: input.viewport ?? FILL_PREVIEW_VIEWPORT,
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(runtime === undefined ? {} : { runtime }),
        ...(desktopHostId === undefined ? {} : { desktopHostId }),
        ...(runtime === "server"
          ? {
              backingPage:
                desktopHostId === undefined
                  ? ("server" as const)
                  : input.desktopPopup === undefined
                    ? createDesktopRoot === undefined
                      ? ("desktop" as const)
                      : ("desktop-root" as const)
                    : ("desktop-popup" as const),
              ...(desktopHostId === undefined || input.desktopPopup === undefined
                ? {}
                : { desktopPopupId: input.desktopPopup.popupId }),
            }
          : {}),
        ...(runtime === "server" && input.automationOwner !== undefined
          ? { automationOwner: input.automationOwner }
          : {}),
        ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
        updatedAt,
      };
      // Native creation can await transport and re-enter this service; keep it outside the lock.
      const nativeRoot = createDesktopRoot ? yield* createDesktopRoot(snapshot) : undefined;
      if (nativeRoot) snapshot = { ...snapshot, desktopRootId: nativeRoot.rootId };
      let publicationCommitted = false;
      yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          const revision = state.revision + 1;
          const sessions = new Map(state.sessions);
          sessions.set(compositeKey(input.threadId, tabId), {
            threadId: input.threadId,
            tabId,
            snapshot,
          });
          input.beforePublish?.(snapshot);
          if (nativeRoot) yield* nativeRoot.publish();
          yield* persistSessions(sessions);
          publicationCommitted = true;
          if (snapshot.backingPage === "desktop-popup" && input.desktopPopup?.close)
            nativeCloseGuards.set(compositeKey(input.threadId, tabId), input.desktopPopup.close);
          if (nativeRoot)
            nativeCloseGuards.set(compositeKey(input.threadId, tabId), nativeRoot.close);
          yield* PubSub.publish(eventsPubSub, {
            type: "opened",
            threadId: input.threadId,
            tabId,
            createdAt: snapshot.updatedAt,
            serverEpoch,
            revision,
            snapshot,
            ...(input.background === undefined ? {} : { background: input.background }),
            ...(input.focus === undefined ? {} : { focus: input.focus }),
          });
          return [snapshot, { sessions, revision }] as const;
        }),
      ).pipe(
        Effect.uninterruptible,
        Effect.onError(() =>
          publicationCommitted
            ? Effect.void
            : (nativeRoot?.close().pipe(Effect.ignore) ?? Effect.void),
        ),
      );
      return snapshot;
    },
  );

  const restoreDesktopRoot: PreviewManager["Service"]["restoreDesktopRoot"] = Effect.fn(
    "PreviewManager.restoreDesktopRoot",
  )(function* (input) {
    const key = compositeKey(input.threadId, input.tabId);
    const state = yield* SynchronizedRef.get(stateRef);
    const original = state.sessions.get(key);
    if (!original)
      return yield* new PreviewSessionLookupError({ threadId: input.threadId, tabId: input.tabId });
    if (
      original.snapshot.backingPage !== "desktop-root" ||
      original.snapshot.desktopRootId !== undefined
    )
      return yield* new PreviewNativeCreateError({
        tabId: input.tabId,
        cause: "The native browser root is already bound.",
      });
    const root = yield* input.create(original.snapshot);
    let committed = false;
    return yield* SynchronizedRef.modifyEffect(stateRef, (current) =>
      Effect.gen(function* () {
        const session = current.sessions.get(key);
        if (!session)
          return yield* new PreviewSessionLookupError({
            threadId: input.threadId,
            tabId: input.tabId,
          });
        if (
          session.snapshot.backingPage !== "desktop-root" ||
          session.snapshot.desktopRootId !== undefined
        )
          return yield* new PreviewNativeCreateError({
            tabId: input.tabId,
            cause: "The native browser root is already bound.",
          });
        // Native IDs are ephemeral; the persisted dormant destination is unchanged.
        const snapshot = { ...session.snapshot, desktopRootId: root.rootId };
        const sessions = new Map(current.sessions);
        sessions.set(key, { ...session, snapshot });
        yield* root.publish();
        nativeCloseGuards.set(key, root.close);
        committed = true;
        const revision = current.revision + 1;
        yield* PubSub.publish(eventsPubSub, {
          type: "navigated",
          threadId: input.threadId,
          tabId: input.tabId,
          createdAt: snapshot.updatedAt,
          serverEpoch,
          revision,
          snapshot,
        });
        return [snapshot, { sessions, revision }] as const;
      }),
    ).pipe(
      Effect.uninterruptible,
      Effect.onError(() => (committed ? Effect.void : root.close().pipe(Effect.ignore))),
    );
  });

  const reportStatus: PreviewManager["Service"]["reportStatus"] = Effect.fn(
    "PreviewManager.reportStatus",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.reportSessionStatus")(function* (session) {
        if (session.snapshot.runtime === "server" && !input.serverControlled)
          return yield* new PreviewControlRequiredError({ tabId: input.tabId });
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          ...session.snapshot,
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
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
                ...(input.navStatus.download === undefined
                  ? {}
                  : { download: input.navStatus.download }),
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

  const markHeadless: PreviewManager["Service"]["markHeadless"] = Effect.fn(
    "PreviewManager.markHeadless",
  )(function* (input) {
    return yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.markSessionHeadless")(function* (session) {
        if (session.snapshot.headless) return { next: session, emit: null, result: undefined };
        const snapshot: PreviewSessionSnapshot = {
          ...session.snapshot,
          headless: true,
          updatedAt: yield* currentIsoTimestamp,
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
          result: undefined,
        };
      }),
    );
  });

  const claimRecovery: PreviewManager["Service"]["claimRecovery"] = Effect.fn(
    "PreviewManager.claimRecovery",
  )(function* (input) {
    if (recoveryClaimsLoadError !== null) {
      return yield* new PreviewRecoveryStorageError({ cause: recoveryClaimsLoadError });
    }
    const key = recoveryClaimKey(input.threadId, input.url);
    const now = yield* Clock.currentTimeMillis;
    const commandId = CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const messageId = MessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
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
        commandId,
        messageId,
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

  const adjust: PreviewManager["Service"]["adjust"] = Effect.fn("PreviewManager.adjust")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.adjustSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            ...(input.colorScheme === undefined ? {} : { colorScheme: input.colorScheme }),
            ...(input.zoomFactor === undefined ? {} : { zoomFactor: input.zoomFactor }),
            updatedAt,
          };
          const request =
            input.hardReload || input.clear
              ? {
                  request: {
                    ...(input.hardReload ? { hardReload: true } : {}),
                    ...(input.clear ? { clear: input.clear } : {}),
                  },
                }
              : {};
          return {
            next: { ...session, snapshot },
            emit: {
              ...request,
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

  const commitClosed = Effect.fn("PreviewManager.commitClosed")(function* (
    targetKeys: ReadonlySet<string>,
    withoutNative = false,
  ) {
    const createdAt = yield* currentIsoTimestamp;
    yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
      const eventsToEmit: PreviewEvent[] = [];
      const sessions = new Map(state.sessions);
      const targets = [...state.sessions.values()].filter(
        (session) =>
          targetKeys.has(compositeKey(session.threadId, session.tabId)) &&
          (!withoutNative ||
            (session.snapshot.backingPage !== "desktop-popup" &&
              (session.snapshot.backingPage !== "desktop-root" ||
                session.snapshot.desktopRootId === undefined))),
      );
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
      return persistSessions(sessions).pipe(
        Effect.andThen(
          Effect.forEach(eventsToEmit, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          }),
        ),
        Effect.as([undefined, { sessions, revision }] as const),
      );
    });
    const current = yield* SynchronizedRef.get(stateRef);
    for (const key of targetKeys) {
      if (!current.sessions.has(key)) nativeCloseGuards.delete(key);
    }
  });

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const state = yield* SynchronizedRef.get(stateRef);
      const targets = sessionsForThread(state, input.threadId).filter(
        (session) => input.tabId === undefined || session.tabId === input.tabId,
      );
      yield* commitClosed(
        new Set(targets.map((target) => compositeKey(target.threadId, target.tabId))),
        true,
      );
      let firstFailure: PreviewError | undefined;
      // Native acknowledgment can re-enter the manager. Never await it under the state lock.
      for (const target of targets) {
        const key = compositeKey(target.threadId, target.tabId);
        const current = yield* SynchronizedRef.get(stateRef);
        if (!current.sessions.has(key)) continue;
        const guard = nativeCloseGuards.get(key);
        if (!guard) {
          firstFailure ??= new PreviewNativeCloseError({
            tabId: target.tabId,
            reason: "unavailable",
          });
          continue;
        }
        const result = yield* guard().pipe(
          Effect.match({
            onSuccess: () => ({ ok: true as const }),
            onFailure: (error) => ({ ok: false as const, error }),
          }),
        );
        if (result.ok) yield* commitClosed(new Set([compositeKey(target.threadId, target.tabId)]));
        else firstFailure ??= result.error;
      }
      if (firstFailure) return yield* firstFailure;
    },
  );

  const list: PreviewManager["Service"]["list"] = Effect.fn("PreviewManager.list")(
    function* (input) {
      return yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state): PreviewListResult => ({
          sessions: (input.threadId === undefined
            ? Array.from(state.sessions.values())
            : sessionsForThread(state, input.threadId)
          )
            .map((s) => s.snapshot)
            .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
          serverEpoch,
          revision: state.revision,
        })),
      );
    },
  );

  const requestReveal: PreviewManager["Service"]["requestReveal"] = Effect.fn(
    "PreviewManager.requestReveal",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.revealSession")(function* (session) {
        const snapshot = {
          ...session.snapshot,
          reveal: true,
          revealRequest: {
            id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
            force: input.force,
          },
          updatedAt: yield* currentIsoTimestamp,
        };
        return {
          next: { ...session, snapshot },
          emit: {
            type: "navigated" as const,
            threadId: session.threadId,
            tabId: session.tabId,
            createdAt: snapshot.updatedAt,
            snapshot,
          },
          result: undefined,
        };
      }),
    );
  });

  const nativeDormantConfirmed: PreviewManager["Service"]["nativeDormantConfirmed"] = Effect.fn(
    "PreviewManager.nativeDormantConfirmed",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.releaseNativeRendering")(function* (session) {
        const snapshot = {
          ...dormantSnapshot(session.snapshot),
          updatedAt: yield* currentIsoTimestamp,
        };
        return {
          next: { ...session, snapshot },
          emit: {
            type: "navigated" as const,
            threadId: session.threadId,
            tabId: session.tabId,
            createdAt: snapshot.updatedAt,
            snapshot,
          },
          result: undefined,
        };
      }),
    );
    nativeCloseGuards.delete(compositeKey(input.threadId, input.tabId));
  });

  return PreviewManager.of({
    open,
    restoreDesktopRoot,
    requestReveal,
    reportStatus,
    markHeadless,
    getHostedOrigins,
    rememberHostedOrigin,
    claimRecovery,
    resize,
    adjust,
    close,
    nativeClosedConfirmed: Effect.fn("PreviewManager.nativeClosedConfirmed")((input) =>
      commitClosed(new Set([compositeKey(input.threadId, input.tabId)])),
    ),
    nativeDormantConfirmed,
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
