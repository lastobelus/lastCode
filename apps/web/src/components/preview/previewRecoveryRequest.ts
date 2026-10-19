import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";
import { randomUUID, newMessageId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { previewEnvironment } from "~/state/preview";

const REQUEST_IDENTITY_TTL_MS = 24 * 60 * 60 * 1_000;
const IDLE_REQUEST: PreviewRecoveryRequestState = { status: "idle" };

export interface PreviewRecoveryRequestState {
  readonly status: "idle" | "sending" | "sent" | "error";
  readonly error?: string;
}

export interface RequestPreviewRecoveryInput {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly code: number;
  readonly description: string;
  readonly title?: string;
  readonly tabId?: string;
}

interface DispatchSnapshot {
  readonly text: string;
  readonly modelSelection: NonNullable<ReturnType<typeof readThreadShell>>["modelSelection"];
  readonly runtimeMode: NonNullable<ReturnType<typeof readThreadShell>>["runtimeMode"];
  readonly interactionMode: NonNullable<ReturnType<typeof readThreadShell>>["interactionMode"];
  readonly createdAt: string;
}

interface PreviewRecoveryRequestEntry {
  readonly state: PreviewRecoveryRequestState;
  readonly commandId: ReturnType<typeof CommandId.make>;
  readonly messageId: ReturnType<typeof newMessageId>;
  readonly createdAt: string;
  readonly snapshot: DispatchSnapshot | null;
}

interface PreviewRecoveryRequestStore {
  readonly byRequestKey: Readonly<Record<string, PreviewRecoveryRequestEntry>>;
  readonly setEntry: (key: string, entry: PreviewRecoveryRequestEntry) => void;
  readonly clear: (key: string) => void;
  readonly pruneExpired: () => void;
}

const PersistedRequestEntry = Schema.Struct({
  state: Schema.Union([
    Schema.Struct({ status: Schema.Literal("sending") }),
    Schema.Struct({ status: Schema.Literal("sent") }),
    Schema.Struct({ status: Schema.Literal("error"), error: Schema.String }),
  ]),
  commandId: CommandId,
  messageId: MessageId,
  createdAt: IsoDateTime,
  snapshot: Schema.NullOr(
    Schema.Struct({
      text: Schema.String,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
      createdAt: IsoDateTime,
    }),
  ),
});
const decodePersistedRequestEntry = Schema.decodeUnknownOption(PersistedRequestEntry);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreRequestEntries(
  value: unknown,
  now: number,
): Record<string, PreviewRecoveryRequestEntry> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, PreviewRecoveryRequestEntry]> = [];
  for (const [key, rawEntry] of Object.entries(value)) {
    const parsed = Option.getOrUndefined(decodePersistedRequestEntry(rawEntry));
    if (!parsed) continue;
    const createdAtMs = Date.parse(parsed.createdAt);
    if (!Number.isFinite(createdAtMs) || now - createdAtMs > REQUEST_IDENTITY_TTL_MS) continue;
    entries.push([
      key,
      {
        ...parsed,
        state:
          parsed.state.status === "sending"
            ? {
                status: "error",
                error: "The app restarted before confirming this request. Retry safely.",
              }
            : parsed.state,
      },
    ]);
  }
  return Object.fromEntries(entries);
}

const previewRecoveryStorage = createJSONStorage(() => {
  let browserStorage: Storage | undefined;
  try {
    browserStorage = typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    /* Storage may be blocked by the client. */
  }
  const base = resolveStorage(browserStorage);
  return {
    getItem: (key: string) => {
      try {
        return base.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key: string, value: string) => {
      try {
        base.setItem(key, value);
      } catch (error) {
        console.warn("Preview recovery requests could not be saved on this client.", error);
      }
    },
    removeItem: (key: string) => {
      try {
        base.removeItem(key);
      } catch {
        /* Preserve the current in-memory request state. */
      }
    },
  };
});

export const usePreviewRecoveryRequestStore = create<PreviewRecoveryRequestStore>()(
  persist(
    (set) => ({
      byRequestKey: {},
      setEntry: (key, entry) =>
        set((state) => {
          const byRequestKey = { ...pruneEntries(state.byRequestKey, Date.now()) };
          byRequestKey[key] = entry;
          return { byRequestKey };
        }),
      clear: (key) =>
        set((state) => {
          if (!(key in state.byRequestKey)) return state;
          const { [key]: _removed, ...byRequestKey } = state.byRequestKey;
          return { byRequestKey };
        }),
      pruneExpired: () =>
        set((state) => {
          const byRequestKey = pruneEntries(state.byRequestKey, Date.now());
          return Object.keys(byRequestKey).length === Object.keys(state.byRequestKey).length
            ? state
            : { byRequestKey };
        }),
    }),
    {
      name: "lastcode:preview-recovery:v1",
      version: 1,
      storage: previewRecoveryStorage,
      partialize: ({ byRequestKey }) => ({ byRequestKey }),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {};
        return {
          ...current,
          byRequestKey: restoreRequestEntries(saved.byRequestKey, Date.now()),
        };
      },
    },
  ),
);

function pruneEntries(
  entries: Readonly<Record<string, PreviewRecoveryRequestEntry>>,
  now: number,
): Record<string, PreviewRecoveryRequestEntry> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => {
      const createdAt = Date.parse(entry.createdAt);
      return Number.isFinite(createdAt) && now - createdAt <= REQUEST_IDENTITY_TTL_MS;
    }),
  );
}

const pendingRequests = new Map<string, Promise<void>>();

function requestKey(threadRef: ScopedThreadRef, url: string): string {
  return JSON.stringify([scopedThreadKey(threadRef), url]);
}

export function usePreviewRecoveryRequest(
  threadRef: ScopedThreadRef | null,
  url: string,
  tabId?: string,
): PreviewRecoveryRequestState {
  const key = threadRef && url ? requestKey(threadRef, url) : null;
  const entry = usePreviewRecoveryRequestStore((state) =>
    key ? (state.byRequestKey[key] ?? null) : null,
  );
  const createdAt = entry?.createdAt;
  useEffect(() => {
    if (!createdAt) return;
    const expiresAt = Date.parse(createdAt) + REQUEST_IDENTITY_TTL_MS;
    const timer = setTimeout(
      () => usePreviewRecoveryRequestStore.getState().pruneExpired(),
      Math.max(0, expiresAt - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [createdAt]);
  const status = entry?.state.status;
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  useEffect(() => {
    if (!environmentId || !threadId || !tabId || !url || status !== "sent") return;
    void reconcileAcceptedRequest({ environmentId, threadId }, url, tabId);
  }, [status, tabId, environmentId, threadId, url]);
  return entry?.state ?? IDLE_REQUEST;
}

const pendingReconciliations = new Set<string>();

async function reconcileAcceptedRequest(
  threadRef: ScopedThreadRef,
  url: string,
  tabId: string,
): Promise<void> {
  const key = requestKey(threadRef, url);
  if (pendingReconciliations.has(key)) return;
  const acceptedEntry = usePreviewRecoveryRequestStore.getState().byRequestKey[key];
  if (acceptedEntry?.state.status !== "sent") return;
  pendingReconciliations.add(key);
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      previewEnvironment.claimRecovery,
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId, url },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") return;
    const current = usePreviewRecoveryRequestStore.getState().byRequestKey[key];
    if (
      current?.state.status === "sent" &&
      (current.commandId !== result.value.commandId || current.messageId !== result.value.messageId)
    ) {
      usePreviewRecoveryRequestStore.getState().clear(key);
    }
  } catch {
    // A transient claim failure leaves the previously accepted state intact.
  } finally {
    pendingReconciliations.delete(key);
  }
}

/** Call after that exact URL loads successfully; failed reloads keep request suppression. */
export function clearPreviewRecoveryRequest(threadRef: ScopedThreadRef, url: string): void {
  usePreviewRecoveryRequestStore.getState().clear(requestKey(threadRef, url));
}

/** Send one idempotent recovery request to the owning thread. */
export function requestPreviewRecovery(input: RequestPreviewRecoveryInput): Promise<void> {
  const key = requestKey(input.threadRef, input.url);
  const store = usePreviewRecoveryRequestStore.getState();
  store.pruneExpired();
  const refreshedStore = usePreviewRecoveryRequestStore.getState();
  const current = refreshedStore.byRequestKey[key];
  const pending = pendingRequests.get(key);
  if (pending) return pending;

  const commandId = current?.commandId ?? CommandId.make(randomUUID());
  const messageId = current?.messageId ?? newMessageId();
  const initialEntry: PreviewRecoveryRequestEntry = {
    state: { status: "sending" },
    commandId,
    messageId,
    createdAt: current?.createdAt ?? new Date().toISOString(),
    snapshot: current?.snapshot ?? null,
  };
  usePreviewRecoveryRequestStore.getState().setEntry(key, initialEntry);

  const task = dispatchPreviewRecovery(
    input,
    key,
    initialEntry,
    current?.state.status === "sent",
  ).finally(() => {
    pendingRequests.delete(key);
  });
  pendingRequests.set(key, task);
  return task;
}

async function dispatchPreviewRecovery(
  input: RequestPreviewRecoveryInput,
  key: string,
  entry: PreviewRecoveryRequestEntry,
  wasAlreadySent: boolean,
): Promise<void> {
  let recoveryEntry = entry;
  try {
    const shell = readThreadShell(input.threadRef);
    if (!shell) {
      throw new Error("This thread is no longer available to restore the preview.");
    }
    if (!input.tabId) {
      throw new Error("This preview tab is no longer available to restore the preview.");
    }

    const claimResult = await runAtomCommand(
      appAtomRegistry,
      previewEnvironment.claimRecovery,
      {
        environmentId: input.threadRef.environmentId,
        input: { threadId: input.threadRef.threadId, tabId: input.tabId, url: input.url },
      },
      { reportFailure: false },
    );
    if (claimResult._tag === "Failure") throw squashAtomCommandFailure(claimResult);
    const claim = claimResult.value;
    const changedCanonicalIdentity =
      entry.commandId !== claim.commandId || entry.messageId !== claim.messageId;

    const snapshot =
      !changedCanonicalIdentity && entry.snapshot
        ? entry.snapshot
        : {
            text: recoveryMessage(input, shell.title),
            modelSelection: shell.modelSelection,
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            createdAt: changedCanonicalIdentity ? new Date().toISOString() : entry.createdAt,
          };
    const nextEntry = {
      ...entry,
      commandId: claim.commandId,
      messageId: claim.messageId,
      createdAt: snapshot.createdAt,
      snapshot,
    };
    recoveryEntry = nextEntry;
    usePreviewRecoveryRequestStore.getState().setEntry(key, nextEntry);

    if (wasAlreadySent && !changedCanonicalIdentity) {
      updateRequestState(key, nextEntry, { status: "sent" });
      return;
    }

    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      {
        environmentId: input.threadRef.environmentId,
        input: {
          threadId: input.threadRef.threadId,
          commandId: nextEntry.commandId,
          message: {
            messageId: nextEntry.messageId,
            role: "user",
            text: snapshot.text,
            attachments: [],
          },
          ...(snapshot.modelSelection ? { modelSelection: snapshot.modelSelection } : {}),
          runtimeMode: snapshot.runtimeMode,
          interactionMode: snapshot.interactionMode,
          createdAt: snapshot.createdAt,
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    updateRequestState(key, nextEntry, { status: "sent" });
  } catch (error) {
    updateRequestState(key, recoveryEntry, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function recoveryMessage(input: RequestPreviewRecoveryInput, threadTitle: string): string {
  const title = input.title?.trim() || threadTitle;
  const details = [
    `Preview URL: ${input.url}`,
    `Browser error: ${input.description || `ERR_${Math.abs(input.code) || "FAILED"}`} (${input.code})`,
    ...(title ? [`Page or thread title: ${title}`] : []),
    ...(input.tabId ? [`Preview tab ID: ${input.tabId}`] : []),
    `Owning thread ID: ${input.threadRef.threadId}`,
  ];
  return [
    "Please restore the preview for this thread so I can reopen the failed link.",
    "The following details came from the preview page:",
    ...details.map((detail) => `- ${detail}`),
  ].join("\n");
}

function updateRequestState(
  key: string,
  expected: PreviewRecoveryRequestEntry,
  state: PreviewRecoveryRequestState,
): void {
  const current = usePreviewRecoveryRequestStore.getState().byRequestKey[key];
  if (current?.commandId !== expected.commandId || current.messageId !== expected.messageId) return;
  usePreviewRecoveryRequestStore.getState().setEntry(key, { ...current, state });
}
