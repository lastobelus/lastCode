import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["preview", "terminal", "attachment"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupArchivedTerminals: (
    threadId: string,
  ) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupArchivedTerminals: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const live = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewHosting.PreviewHosting;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    return {
      cleanupTerminals: (threadId: string) =>
        previews.removeThread(threadId).pipe(
          Effect.mapError(
            (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
          ),
          Effect.andThen(
            terminals
              .close({ threadId, deleteHistory: true })
              .pipe(
                Effect.mapError(
                  (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
                ),
              ),
          ),
        ),
      cleanupArchivedTerminals: (threadId: string) =>
        previews.list(threadId).pipe(
          Effect.mapError(
            (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
          ),
          Effect.flatMap((leases) =>
            terminals
              .closeThreadExcept(
                threadId,
                leases.map((lease) => lease.terminalId),
              )
              .pipe(
                Effect.mapError(
                  (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
                ),
              ),
          ),
        ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return path === null
              ? Effect.void
              : fileSystem
                  .remove(path, { force: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                    ),
                  );
          },
          { discard: true, concurrency: 4 },
        ),
    };
  }),
);
