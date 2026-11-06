// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { RunId, RunAttemptId, ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;
const MAX_LIVE_ORIGINS = 4096;
const MAX_ENDED_ORIGINS = 4096;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

const hashHtml = (html: string) => NodeCrypto.createHash("sha256").update(html).digest("hex");

export interface McpExecutionOrigin {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
}

export type McpNativeOrigin =
  | { readonly provider: "codex"; readonly nativeThreadId: string; readonly nativeTurnId: string }
  | { readonly provider: "claude"; readonly toolUseId: string };

const originKey = (origin: McpNativeOrigin): string =>
  JSON.stringify(
    origin.provider === "codex"
      ? [origin.provider, origin.nativeThreadId, origin.nativeTurnId]
      : [origin.provider, origin.toolUseId],
  );
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nativeOriginFromMetadata = (metadata: unknown): McpNativeOrigin | undefined => {
  const meta = record(metadata);
  const codex = record(meta?.["x-codex-turn-metadata"]);
  const toolUseId = meta?.["claudecode/toolUseId"];
  if (codex !== undefined && toolUseId !== undefined) return undefined;
  if (typeof codex?.thread_id === "string" && typeof codex.turn_id === "string") {
    return { provider: "codex", nativeThreadId: codex.thread_id, nativeTurnId: codex.turn_id };
  }
  return typeof toolUseId === "string" ? { provider: "claude", toolUseId } : undefined;
};

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly beginCodexTurn: (
      threadId: ThreadId,
      nativeThreadId: string,
    ) => Effect.Effect<Effect.Effect<void>>;
    readonly registerExecution: (
      threadId: ThreadId,
      origin: McpNativeOrigin,
      execution: McpExecutionOrigin,
    ) => Effect.Effect<void>;
    readonly endExecution: (
      threadId: ThreadId,
      execution: McpExecutionOrigin,
    ) => Effect.Effect<void>;
    readonly resolveExecution: (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: string;
      readonly authorizationHeader: string;
      readonly metadata: unknown;
    }) => Effect.Effect<McpExecutionOrigin | undefined>;
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: { readonly html: string; readonly title: string; readonly height: number },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    // A reported attachment consumes that exact page; otherwise only unique input matches count.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const matchingPageIndex = (
  kept: ReadonlyArray<KeptHtmlRender>,
  input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
): number => {
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const htmlHash = hashHtml(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.title === input.title &&
    page.height === height &&
    (page.htmlHash === htmlHash ||
      (tail !== undefined &&
        tail.length > 0 &&
        tail.length < page.htmlLength &&
        page.htmlEnd.endsWith(tail)))
      ? [index]
      : [],
  );
  return matches.length === 1 ? matches[0]! : -1;
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const pendingCodex = new Map<
    ThreadId,
    { readonly nativeThreadId: string; readonly ready: Deferred.Deferred<void> }
  >();
  const endedOrigins = new Map<ThreadId, Set<string>>();
  const origins = new Map<
    ThreadId,
    Map<
      string,
      {
        readonly config: McpProviderSessionConfig;
        readonly execution: McpExecutionOrigin;
      }
    >
  >();
  return McpProviderSessions.of({
    beginCodexTurn: Effect.fn("McpProviderSessions.beginCodexTurn")(
      function* (threadId, nativeThreadId) {
        const ready = yield* Deferred.make<void>();
        const pending = { nativeThreadId, ready };
        pendingCodex.set(threadId, pending);
        return Effect.sync(() => {
          if (pendingCodex.get(threadId) === pending) pendingCodex.delete(threadId);
        }).pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.asVoid);
      },
    ),
    registerExecution: Effect.fn("McpProviderSessions.registerExecution")(
      function* (threadId, origin, execution) {
        const config = (yield* Ref.get(sessions)).get(threadId);
        if (config === undefined) return;
        const entries = origins.get(threadId) ?? new Map();
        const key = originKey(origin);
        // Ended history never consumes live capacity; neither category may rebind a known key.
        if (
          entries.has(key) ||
          endedOrigins.get(threadId)?.has(key) ||
          entries.size >= MAX_LIVE_ORIGINS
        )
          return;
        entries.set(key, { config, execution: Object.freeze({ ...execution }) });
        origins.set(threadId, entries);
      },
    ),
    endExecution: Effect.fn("McpProviderSessions.endExecution")(function (threadId, execution) {
      return Effect.sync(() => {
        const entries = origins.get(threadId);
        for (const [key, entry] of entries ?? []) {
          if (
            entry.execution.runId === execution.runId &&
            entry.execution.attemptId === execution.attemptId
          ) {
            entries?.delete(key);
            const ended = endedOrigins.get(threadId) ?? new Set<string>();
            ended.add(key);
            // Expiring a tombstone does not create a binding. Only the adapter can
            // register a native identity; stale HTTP metadata remains unattributed.
            if (ended.size > MAX_ENDED_ORIGINS) {
              const oldest = ended.values().next().value;
              if (oldest !== undefined) ended.delete(oldest);
            }
            endedOrigins.set(threadId, ended);
          }
        }
        if (entries?.size === 0) origins.delete(threadId);
      });
    }),
    resolveExecution: Effect.fn("McpProviderSessions.resolveExecution")(function* (input) {
      const origin = nativeOriginFromMetadata(input.metadata);
      if (origin === undefined) return undefined;
      const config = (yield* Ref.get(sessions)).get(input.threadId);
      if (
        config?.providerSessionId !== input.providerSessionId ||
        config.authorizationHeader !== input.authorizationHeader
      )
        return undefined;
      const pending = pendingCodex.get(input.threadId);
      // HTTP and app-server notifications use different connections. Only wait for a
      // known in-progress start, then look up the original IDs without changing them.
      if (
        origin.provider === "codex" &&
        pending?.nativeThreadId === origin.nativeThreadId &&
        !origins.get(input.threadId)?.has(originKey(origin)) &&
        !endedOrigins.get(input.threadId)?.has(originKey(origin))
      ) {
        yield* Deferred.await(pending.ready);
      }
      const entry = origins.get(input.threadId)?.get(originKey(origin));
      return entry?.config.providerSessionId === input.providerSessionId &&
        entry.config.authorizationHeader === input.authorizationHeader
        ? entry.execution
        : undefined;
    }),
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (
        current.get(config.threadId)?.providerSessionId !== config.providerSessionId ||
        current.get(config.threadId)?.authorizationHeader !== config.authorizationHeader
      ) {
        origins.delete(config.threadId);
        endedOrigins.delete(config.threadId);
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
      }
      yield* Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
    read: Effect.fn("McpProviderSessions.read")(function (threadId) {
      return Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId)));
    }),
    clear: Effect.fn("McpProviderSessions.clear")(function (threadId) {
      origins.delete(threadId);
      endedOrigins.delete(threadId);
      return Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(htmlRenders, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
      );
    }),
    recordHtmlRender: Effect.fn("McpProviderSessions.recordHtmlRender")(
      function (threadId, input, reference) {
        return Ref.update(htmlRenders, (current) =>
          new Map(current).set(
            threadId,
            [
              ...(current.get(threadId) ?? []),
              {
                title: input.title,
                height: input.height,
                htmlLength: input.html.length,
                htmlHash: hashHtml(input.html),
                // Copy the tail so its backing storage cannot retain the entire HTML string.
                htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                  "utf16le",
                ),
                reference,
              },
            ].slice(-MAX_KEPT_HTML_RENDERS),
          ),
        );
      },
    ),
    takeHtmlRender: Effect.fn("McpProviderSessions.takeHtmlRender")(
      function (threadId, input, reported) {
        return Ref.modify(htmlRenders, (current) => {
          const kept = current.get(threadId) ?? [];
          const index =
            reported === undefined
              ? matchingPageIndex(kept, input)
              : kept.findIndex((page) => page.reference.attachmentId === reported.attachmentId);
          if (index === -1) {
            return [undefined, current];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const next = new Map(current);
          if (rest.length === 0) {
            next.delete(threadId);
          } else {
            next.set(threadId, rest);
          }
          return [kept[index]!.reference, next];
        });
      },
    ),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
