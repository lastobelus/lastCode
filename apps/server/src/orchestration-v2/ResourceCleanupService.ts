import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment", "scheduled-tasks"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupArchivedTerminals: (
    threadId: string,
  ) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupArchivedTerminals: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewHosting.PreviewHosting;
    const browser = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    return {
      cleanupScheduledTasks: Effect.fn("ResourceCleanupService.cleanupScheduledTasks")(function (
        threadId: ThreadId,
      ) {
        return scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          );
      }),
      cleanupTerminals: Effect.fn("ResourceCleanupService.cleanupTerminals")(function* (
        threadId: string,
      ) {
        const browserResult = yield* Effect.result(
          browser.close({ threadId: ThreadId.make(threadId) }),
        );
        const preview = yield* Effect.result(previews.removeThread(threadId));
        // Attempt every deleted-thread resource even when another resource needs retry.
        const terminal = yield* Effect.result(terminals.close({ threadId, deleteHistory: true }));
        if (browserResult._tag === "Failure") {
          return yield* new ResourceCleanupError({
            operation: "preview",
            threadId,
            cause: {
              browser: browserResult.failure,
              ...(preview._tag === "Failure" ? { preview: preview.failure } : {}),
              ...(terminal._tag === "Failure" ? { terminal: terminal.failure } : {}),
            },
          });
        }
        if (preview._tag === "Failure") {
          return yield* new ResourceCleanupError({
            operation: "preview",
            threadId,
            cause:
              terminal._tag === "Failure"
                ? { preview: preview.failure, terminal: terminal.failure }
                : preview.failure,
          });
        }
        if (terminal._tag === "Failure") {
          return yield* new ResourceCleanupError({
            operation: "terminal",
            threadId,
            cause: terminal.failure,
          });
        }
      }),
      cleanupPreviews: Effect.fn("ResourceCleanupService.cleanupPreviews")(function (
        threadId: string,
      ) {
        return browser
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          );
      }),
      cleanupArchivedTerminals: Effect.fn("ResourceCleanupService.cleanupArchivedTerminals")(
        function* (threadId: string) {
          const previewsResult = yield* Effect.result(previews.list(threadId));
          // An unreadable lease file cannot identify owners; preserve the managed namespace.
          yield* terminals
            .closeThreadExcept(
              threadId,
              previewsResult._tag === "Success"
                ? previewsResult.success.map((lease) => lease.terminalId)
                : [],
              previewsResult._tag === "Failure" ? ["preview-"] : [],
            )
            .pipe(
              Effect.mapError(
                (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
              ),
            );
          if (previewsResult._tag === "Failure") {
            return yield* new ResourceCleanupError({
              operation: "preview",
              threadId,
              cause: previewsResult.failure,
            });
          }
        },
      ),
      cleanupAttachments: Effect.fn("ResourceCleanupService.cleanupAttachments")(function (
        attachmentIds: ReadonlyArray<string>,
      ) {
        return Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const extension = parseAttachmentFileExtension(attachmentId);
            const path =
              resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId,
              }) ??
              (extension
                ? resolveAttachmentRelativePath({
                    attachmentsDir: config.attachmentsDir,
                    relativePath: `${attachmentId}.${extension}`,
                  })
                : null);
            return path === null
              ? Effect.void
              : fileSystem.remove(path, { force: true }).pipe(
                  Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true })),
                  Effect.mapError(
                    (cause) =>
                      new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                  ),
                );
          },
          { discard: true, concurrency: 4 },
        );
      }),
    };
  }),
);
