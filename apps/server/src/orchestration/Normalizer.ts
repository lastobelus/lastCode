import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const projectionSnapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    const vcsDriverRegistry = yield* Effect.serviceOption(VcsDriverRegistry.VcsDriverRegistry);
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const resolveGitCommonDir = (cwd: string) =>
      Effect.gen(function* () {
        if (Option.isNone(vcsDriverRegistry)) return null;
        const handle = yield* vcsDriverRegistry.value.resolve({ cwd }).pipe(Effect.option);
        if (Option.isNone(handle) || handle.value.repository.metadataPath === null) {
          return null;
        }
        const metadataPath = handle.value.repository.metadataPath;
        const resolvedPath = path.isAbsolute(metadataPath)
          ? path.normalize(metadataPath)
          : path.resolve(cwd, metadataPath);
        return yield* fileSystem
          .realPath(resolvedPath)
          .pipe(Effect.orElseSucceed(() => resolvedPath));
      });

    const resolveProjectRepositoryKey = (projectId: string) =>
      Effect.gen(function* () {
        if (Option.isNone(projectionSnapshotQuery)) return null;
        const readModel = yield* projectionSnapshotQuery.value
          .getCommandReadModel()
          .pipe(Effect.option);
        if (Option.isNone(readModel)) return null;
        const project = readModel.value.projects.find((candidate) => candidate.id === projectId);
        return project === undefined ? null : yield* resolveGitCommonDir(project.workspaceRoot);
      });

    const resolveThreadDeleteRepositoryKey = (threadId: string) =>
      Effect.gen(function* () {
        if (Option.isNone(projectionSnapshotQuery)) return null;
        const readModel = yield* projectionSnapshotQuery.value
          .getCommandReadModel()
          .pipe(Effect.option);
        if (Option.isNone(readModel)) return null;
        const thread = readModel.value.threads.find((candidate) => candidate.id === threadId);
        return thread === undefined ? null : yield* resolveProjectRepositoryKey(thread.projectId);
      });

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type === "thread.delete" && canonicalCommand.deleteWorktree === true) {
      const repositoryKey = yield* resolveThreadDeleteRepositoryKey(canonicalCommand.threadId);
      const { repositoryKey: _clientRepositoryKey, ...commandWithoutRepositoryKey } =
        canonicalCommand;
      return {
        ...commandWithoutRepositoryKey,
        ...(repositoryKey === null ? {} : { repositoryKey }),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type === "project.delete" && canonicalCommand.force === true) {
      const repositoryKey = yield* resolveProjectRepositoryKey(canonicalCommand.projectId);
      const { repositoryKey: _clientRepositoryKey, ...commandWithoutRepositoryKey } =
        canonicalCommand;
      return {
        ...commandWithoutRepositoryKey,
        ...(repositoryKey === null ? {} : { repositoryKey }),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
