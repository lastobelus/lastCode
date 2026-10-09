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
  PreviewNativeCloseError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  type PreviewRecoveryClaim,
  PreviewRecoveryStorageError,
  type PreviewResizeInput,
  type PreviewAdjustInput,
  FILL_PREVIEW_VIEWPORT,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
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

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly open: (
      input: PreviewOpenInput & {
        readonly automationOwner?: string;
        /** Trusted native creation, unavailable on public open inputs. */
        readonly desktopPopup?: {
          readonly popupId: string;
          /** Waits for the actual native close before discarding its ownership/session. */
          readonly close?: () => Effect.Effect<void, PreviewError>;
        };
        /** Creates an independent native page before any subscriber sees the tab. */
        readonly createDesktopRoot?: (snapshot: PreviewSessionSnapshot) => Effect.Effect<
          {
            readonly rootId: string;
            readonly close: () => Effect.Effect<void, PreviewError>;
            readonly publish: () => Effect.Effect<void, PreviewError>;
          },
          PreviewError
        >;
        /** Runs before the `opened` event publishes, so subscribers find state keyed by the tab. */
        readonly beforePublish?: (snapshot: PreviewSessionSnapshot) => void;
      },
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly navigate: (
      input: PreviewNavigateInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly reportStatus: (
      input: PreviewReportStatusInput & { readonly serverControlled?: boolean },
    ) => Effect.Effect<void, PreviewError>;
    readonly requestReveal: (
      input: PreviewCloseInput & { readonly tabId: string; readonly force: boolean },
    ) => Effect.Effect<void, PreviewError>;
    readonly claimRecovery: (
      input: PreviewClaimRecoveryInput,
    ) => Effect.Effect<PreviewRecoveryClaim, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    /**
     * Records a server tab's appearance or zoom and publishes it; the server's
     * browser applies it to the page. Any client may send it, as it changes how
     * the page renders, not what it does.
     */
    readonly adjust: (
      input: PreviewAdjustInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    /** Trusted native destruction notification; never exposed on public close inputs. */
    readonly nativeClosedConfirmed: (
      input: PreviewCloseInput & { readonly tabId: string },
    ) => Effect.Effect<void>;
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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* PreviewManagerMake() {
  const crypto = yield* Crypto.Crypto;
  const serverEpoch = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
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
  const stateRef = yield* SynchronizedRef.make<ManagerState>(initialState);
  const nativeCloseGuards = new Map<string, () => Effect.Effect<void, PreviewError>>();
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
      const runtime = input.runtime;
      // Choose before publishing: renderers and automation must create the same page.
      // An unavailable selected desktop fails attachment; it never becomes a headless tab.
      const desktopHostId =
        input.desktopHostId ??
        (runtime === "server" &&
        serverConfig.desktopBrowserFd !== undefined &&
        serverConfig.desktopBrowserControlFd !== undefined
          ? "local"
          : undefined);
      // Persisted client surfaces must not bind to a different tab after a server restart.
      const tabId = `${newPreviewTabId()}${runtime === "server" ? `_${serverEpoch}` : ""}`;
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

  const navigate: PreviewManager["Service"]["navigate"] = Effect.fn("PreviewManager.navigate")(
    function* (input) {
      const url = yield* normalizeUrl(input.url);
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.navigateSession")(function* (session) {
          if (session.snapshot.runtime === "server")
            return yield* new PreviewControlRequiredError({ tabId: input.tabId });
          const updatedAt = yield* currentIsoTimestamp;
          const previousTitle =
            session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
          const resolvedTitle = input.resolvedTitle ?? previousTitle;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            navStatus: { _tag: "Success", url, title: resolvedTitle },
            viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
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

  const claimRecovery: PreviewManager["Service"]["claimRecovery"] = Effect.fn(
    "PreviewManager.claimRecovery",
  )(function* (input) {
    if (recoveryClaimsLoadError !== null) {
      return yield* new PreviewRecoveryStorageError({ cause: recoveryClaimsLoadError });
    }
    const key = recoveryClaimKey(input.threadId, input.url);
    const now = yield* Clock.currentTimeMillis;
    const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const messageId = MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
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
        // Any client may size a tab, as the desktop has always allowed; the
        // server's browser follows the published setting for its own tabs.
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
          // One-off requests ride on the event for the server's browser to act on.
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

  const refresh: PreviewManager["Service"]["refresh"] = Effect.fn("PreviewManager.refresh")(
    function* (input) {
      // Verify the session exists; the desktop bridge handles the actual reload
      // and will report progress back via `reportStatus`. No event emitted.
      yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, result: undefined as void }),
      );
    },
  );

  const commitClosed = (targetKeys: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const createdAt = yield* currentIsoTimestamp;
      yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        const eventsToEmit: PreviewEvent[] = [];
        const sessions = new Map(state.sessions);
        const targets = [...state.sessions.values()].filter((session) =>
          targetKeys.has(compositeKey(session.threadId, session.tabId)),
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
        return Effect.as(
          Effect.forEach(eventsToEmit, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          }),
          [undefined, { sessions, revision }] as const,
        );
      });
      for (const key of targetKeys) nativeCloseGuards.delete(key);
    });

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const state = yield* SynchronizedRef.get(stateRef);
      const targets = sessionsForThread(state, input.threadId).filter(
        (session) => input.tabId === undefined || session.tabId === input.tabId,
      );
      yield* commitClosed(
        new Set(
          targets
            .filter(
              (target) =>
                target.snapshot.backingPage !== "desktop-popup" &&
                target.snapshot.backingPage !== "desktop-root",
            )
            .map((target) => compositeKey(target.threadId, target.tabId)),
        ),
      );
      let firstFailure: PreviewError | undefined;
      // Native acknowledgment can re-enter the manager. Never await it under the state lock.
      for (const target of targets) {
        if (
          target.snapshot.backingPage !== "desktop-popup" &&
          target.snapshot.backingPage !== "desktop-root"
        )
          continue;
        const guard = nativeCloseGuards.get(compositeKey(target.threadId, target.tabId));
        if (!guard) {
          const current = yield* SynchronizedRef.get(stateRef);
          if (!current.sessions.has(compositeKey(target.threadId, target.tabId))) continue;
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
      if (firstFailure) return yield* Effect.fail(firstFailure);
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
            id: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
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

  return PreviewManager.of({
    open,
    requestReveal,
    navigate,
    reportStatus,
    claimRecovery,
    resize,
    adjust,
    refresh,
    close,
    nativeClosedConfirmed: (input) =>
      commitClosed(new Set([compositeKey(input.threadId, input.tabId)])),
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
