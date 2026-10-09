import {
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { assistantMarkdownFileReferences } from "@t3tools/shared/assistantMarkdownFiles";
import { stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import {
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "@t3tools/shared/workspaceBasenameLookup";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";

export class ThreadLinkedFileDeniedError extends Schema.TaggedError<ThreadLinkedFileDeniedError>()(
  "ThreadLinkedFileDeniedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This file is not linked by an assistant inside the thread's workspace.";
  }
}

export class ThreadLinkedFileResolutionError extends Schema.TaggedError<ThreadLinkedFileResolutionError>()(
  "ThreadLinkedFileResolutionError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to resolve the thread's linked file.";
  }
}

type LinkedFileError = ThreadLinkedFileDeniedError | ThreadLinkedFileResolutionError;

const PUBLICATION_CACHE_ENTRIES = 256;
const PUBLICATION_CACHE_CHARACTERS = 2_000_000;
type Publication = {
  readonly key: string;
  readonly text: string;
  readonly plan: boolean;
  readonly updatedAt: number;
};

export class ThreadLinkedFiles extends Context.Service<
  ThreadLinkedFiles,
  {
    /** Resolve exactly one linked file, never a directory or the host filesystem. */
    readonly resolveFile: (input: {
      readonly threadId: ThreadId;
      readonly path: string;
      readonly cwd?: string;
    }) => Effect.Effect<
      { readonly cwd: string; readonly relativePath: string; readonly absolutePath: string },
      LinkedFileError
    >;
    readonly readFile: (
      input: ProjectReadFileInput & { readonly linkedThreadId: ThreadId },
    ) => Effect.Effect<
      ProjectReadFileResult,
      | LinkedFileError
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/ThreadLinkedFiles") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  // Cache only parsing: current publications and workspace authority are reread,
  // and filesystem containment is checked anew for every preview request.
  const publicationCache = new Map<
    string,
    {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly text: string;
      readonly references: ReturnType<typeof assistantMarkdownFileReferences>;
      readonly size: number;
    }
  >();
  let cacheCharacters = 0;
  const evictPublication = (key: string) => {
    const entry = publicationCache.get(key);
    if (entry !== undefined) {
      cacheCharacters -= entry.size;
      publicationCache.delete(key);
    }
  };
  const publicationReferences = (publication: Publication, threadId: ThreadId, cwd: string) => {
    const cached = publicationCache.get(publication.key);
    if (cached !== undefined && cached.text === publication.text && cached.cwd === cwd) {
      publicationCache.delete(publication.key);
      publicationCache.set(publication.key, cached);
      return cached.references;
    }
    evictPublication(publication.key);
    const references = assistantMarkdownFileReferences(
      publication.plan ? stripDisplayedPlanMarkdown(publication.text) : publication.text,
      cwd,
    );
    const size =
      publication.key.length +
      cwd.length +
      publication.text.length +
      references.reduce((sum, reference) => sum + reference.path.length, 0);
    if (size <= PUBLICATION_CACHE_CHARACTERS) {
      publicationCache.set(publication.key, {
        threadId,
        cwd,
        text: publication.text,
        references,
        size,
      });
      cacheCharacters += size;
      for (const oldest of publicationCache.keys()) {
        if (
          publicationCache.size <= PUBLICATION_CACHE_ENTRIES &&
          cacheCharacters <= PUBLICATION_CACHE_CHARACTERS
        )
          break;
        evictPublication(oldest);
      }
    }
    return references;
  };

  const resolveFile: ThreadLinkedFiles["Service"]["resolveFile"] = Effect.fn(
    "ThreadLinkedFiles.resolveFile",
  )(function* (input) {
    const records = yield* projections
      .getThreadRecords(input.threadId, ["messages", "plans", "turnItems"], {
        messageRoles: ["assistant"],
        turnItemTypes: ["proposed_plan"],
      })
      .pipe(
        Effect.mapError(
          (cause) => new ThreadLinkedFileResolutionError({ threadId: input.threadId, cause }),
        ),
      );
    const project = yield* projects
      .get(records.thread.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ThreadLinkedFileResolutionError({ threadId: input.threadId, cause }),
        ),
      );
    if (Option.isNone(project))
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });
    const cwd = path.resolve(records.thread.worktreePath ?? project.value.workspaceRoot);
    if (input.cwd !== undefined && path.resolve(input.cwd) !== cwd)
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });
    const requested = input.path;
    if (!requested || requested.includes("\0"))
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });
    const requestedPath = path.resolve(cwd, requested);
    const outside = (relative: string) =>
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative);
    if (outside(path.relative(cwd, requestedPath)))
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });

    const planItems = new Map(
      records.turnItems.flatMap((item) =>
        item.type === "proposed_plan" ? [[item.planId, item] as const] : [],
      ),
    );
    const publications: Array<Publication> = [
      ...records.messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          key: JSON.stringify([input.threadId, "message", message.id]),
          text: message.text,
          plan: false,
          updatedAt: DateTime.toEpochMillis(message.updatedAt),
        })),
      ...records.plans.flatMap((plan) =>
        plan.kind === "proposed_plan" && !planItems.has(plan.id)
          ? [
              {
                key: JSON.stringify([input.threadId, "plan", plan.id]),
                text: plan.markdown,
                plan: true,
                updatedAt: 0,
              },
            ]
          : [],
      ),
      ...Array.from(planItems.values(), (item) => ({
        key: JSON.stringify([input.threadId, "plan", item.planId]),
        text: item.markdown,
        plan: true,
        updatedAt: DateTime.toEpochMillis(item.updatedAt),
      })),
    ]
      .toReversed()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const currentPublications = new Map(publications.map((item) => [item.key, item.text]));
    for (const [key, cached] of publicationCache) {
      if (
        cached.threadId === input.threadId &&
        (cached.cwd !== cwd || currentPublications.get(key) !== cached.text)
      )
        evictPublication(key);
    }

    let absolutePath: string | undefined;
    const checkedFilenames = new Set<string>();
    for (const publication of publications) {
      const references = publicationReferences(publication, input.threadId, cwd);
      if (
        references.some(
          (linked) => !linked.bareFilename && path.resolve(cwd, linked.path) === requestedPath,
        )
      ) {
        absolutePath = requestedPath;
        break;
      }
      for (const linked of references) {
        if (
          !linked.bareFilename ||
          checkedFilenames.has(linked.path) ||
          path.basename(requestedPath).toLowerCase() !== linked.path.toLowerCase()
        )
          continue;
        const filename = linked.path;
        checkedFilenames.add(filename);
        const authoredPath = path.resolve(cwd, filename);
        let selectedPath = authoredPath;
        const existing = yield* fileSystem.stat(authoredPath).pipe(
          Effect.catchTags({
            PlatformError: (cause) =>
              cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
          }),
          Effect.mapError(
            (cause) => new ThreadLinkedFileResolutionError({ threadId: input.threadId, cause }),
          ),
        );
        // Resolve the authored filename before comparing the request: it publishes
        // the existing root file or one bounded picker result, never every sibling
        // with that basename. Accept the picked path for subsequent preview requests.
        if (existing === null) {
          const results = yield* workspaceEntries
            .search({
              cwd,
              query: filename,
              limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
              kind: "file",
            })
            .pipe(
              Effect.mapError(
                (cause) => new ThreadLinkedFileResolutionError({ threadId: input.threadId, cause }),
              ),
            );
          const match = pickWorkspaceBasenameMatch(filename, results.entries);
          if (match === null) continue;
          selectedPath = path.resolve(cwd, match);
        }
        if (requestedPath === authoredPath || requestedPath === selectedPath)
          absolutePath = selectedPath;
        if (absolutePath !== undefined) break;
      }
      if (absolutePath !== undefined) break;
    }
    if (absolutePath === undefined)
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });
    const relativePath = path.relative(cwd, absolutePath);
    if (outside(relativePath))
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });
    const [realRoot, realFile] = yield* Effect.all([
      fileSystem.realPath(cwd),
      fileSystem.realPath(absolutePath),
    ]).pipe(
      Effect.mapError(
        (cause) => new ThreadLinkedFileResolutionError({ threadId: input.threadId, cause }),
      ),
    );
    if (outside(path.relative(realRoot, realFile)))
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });
    const stat = yield* fileSystem
      .stat(realFile)
      .pipe(
        Effect.mapError(
          (cause) => new ThreadLinkedFileResolutionError({ threadId: input.threadId, cause }),
        ),
      );
    if (stat.type !== "File")
      return yield* new ThreadLinkedFileDeniedError({ threadId: input.threadId });
    return { cwd, relativePath, absolutePath: realFile };
  });

  const readFile: ThreadLinkedFiles["Service"]["readFile"] = Effect.fn(
    "ThreadLinkedFiles.readFile",
  )(function* (input) {
    const target = yield* resolveFile({
      threadId: input.linkedThreadId,
      path: input.relativePath,
      cwd: input.cwd,
    });
    // Relative reads perform the filesystem's realpath sandbox check again at the read boundary.
    return yield* workspaceFileSystem.readFile({
      cwd: target.cwd,
      relativePath: target.relativePath,
    });
  });
  return ThreadLinkedFiles.of({ resolveFile, readFile });
});

export const layer = Layer.effect(ThreadLinkedFiles, make);
