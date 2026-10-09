import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as AssistantMarkdownFiles from "@t3tools/shared/assistantMarkdownFiles";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ThreadLinkedFiles from "./ThreadLinkedFiles.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const threadId = ThreadId.make("linked-files-thread");
const projectId = ProjectId.make("linked-files-project");
const layerFiles = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);
const layerBase = Layer.mergeAll(
  VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer)),
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-linked-files-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const withWorkspace = <E>(
  test: (
    root: string,
    outside: string,
  ) => Effect.Effect<
    void,
    E,
    | ThreadLinkedFiles.ThreadLinkedFiles
    | ProjectionStore.ProjectionStoreV2
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-linked-project-" });
    const root = path.join(projectRoot, "thread-worktree");
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-linked-outside-" });
    yield* fs.makeDirectory(root);
    const now = yield* DateTime.now;
    const project = {
      projectId,
      title: "Linked files",
      workspaceRoot: projectRoot,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
      deletedAt: null,
    } satisfies ProjectStore.ProjectRow;
    const layerLinked = ThreadLinkedFiles.layer.pipe(
      Layer.provideMerge(ProjectionStore.layerMemory),
      Layer.provide(layerFiles),
      Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeed(Option.some(project)),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* projections.apply({
        id: EventId.make("created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Linked files",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "example-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: root,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* test(root, outside);
    }).pipe(Effect.provide(layerLinked));
  }).pipe(Effect.provide(layerBase), Effect.scoped);

const addMessage = Effect.fn("addMessage")(function* (
  text: string,
  role: "assistant" | "user" = "assistant",
  id = MessageId.make(`message-${role}`),
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* projections.apply({
    id: EventId.make(`event-${role}`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: role === "assistant" ? "agent" : "user",
      creationSource: "provider",
      id,
      threadId,
      runId: null,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const addPlan = Effect.fn("addPlan")(function* (markdown: string, inTurnItem = false) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const planId = PlanId.make("published-plan");
  const nodeId = NodeId.make("published-plan-node");
  yield* projections.apply({
    id: EventId.make("published-plan-event"),
    type: "plan.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: planId,
      threadId,
      runId: null,
      nodeId,
      kind: "proposed_plan",
      status: "completed",
      markdown: inTurnItem ? "" : markdown,
      ...(inTurnItem ? { detailInTurnItem: true } : {}),
    },
  });
  if (inTurnItem)
    yield* projections.apply({
      id: EventId.make("published-plan-item-event"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("published-plan-item"),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "proposed_plan",
        planId,
        markdown,
        streaming: false,
      },
    });
});

afterEach(() => vi.restoreAllMocks());

describe("ThreadLinkedFiles", () => {
  it.effect.each([false, true])(
    "reads a file published only in a stored plan (turn item: %s)",
    (inTurnItem) =>
      withWorkspace((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
          yield* fs.writeFileString(path.join(root, "report.md"), "plan artifact");
          yield* fs.writeFileString(path.join(root, "hidden.md"), "hidden heading");
          yield* fs.writeFileString(path.join(root, "private.md"), "private");
          yield* addPlan("# [Hidden](./hidden.md)\n\n[Report](./report.md)", inTurnItem);
          yield* addMessage("[Private](./private.md)", "user");
          expect(
            (yield* linked.readFile({
              cwd: root,
              relativePath: "report.md",
              linkedThreadId: threadId,
            })).contents,
          ).toBe("plan artifact");
          for (const file of ["hidden.md", "private.md"]) {
            expect(
              (yield* linked.resolveFile({ threadId, path: file }).pipe(Effect.flip))._tag,
            ).toBe("ThreadLinkedFileDeniedError");
          }
          yield* addPlan("# Replacement plan\n\nNo file links", inTurnItem);
          expect(
            (yield* linked.resolveFile({ threadId, path: "report.md" }).pipe(Effect.flip))._tag,
          ).toBe("ThreadLinkedFileDeniedError");
        }),
      ),
  );

  it.effect("reuses parsed publications, skips older text, and revokes replaced links", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        yield* fs.writeFileString(path.join(root, "report file.md"), "report");
        yield* fs.writeFileString(path.join(root, "replacement.md"), "replacement");
        yield* addMessage("Older assistant text", "assistant", MessageId.make("older-message"));
        yield* addMessage("[Report](./report%20file.md)");
        const parse = vi.spyOn(AssistantMarkdownFiles, "assistantMarkdownFileReferences");
        expect(
          (yield* linked.readFile({
            cwd: root,
            relativePath: "report file.md",
            linkedThreadId: threadId,
          })).contents,
        ).toBe("report");
        yield* linked.resolveFile({ threadId, path: "report file.md" });
        expect(parse).toHaveBeenCalledTimes(1);
        yield* addMessage("[Replacement](./replacement.md)");
        expect(
          (yield* linked.resolveFile({ threadId, path: "report file.md" }).pipe(Effect.flip))._tag,
        ).toBe("ThreadLinkedFileDeniedError");
        expect(
          (yield* linked.readFile({
            cwd: root,
            relativePath: "replacement.md",
            linkedThreadId: threadId,
          })).contents,
        ).toBe("replacement");
        expect(parse).toHaveBeenCalledTimes(3);
        yield* addMessage(
          "[Replacement](./replacement.md)",
          "user",
          MessageId.make("message-assistant"),
        );
        expect(
          (yield* linked.resolveFile({ threadId, path: "replacement.md" }).pipe(Effect.flip))._tag,
        ).toBe("ThreadLinkedFileDeniedError");
      }),
    ),
  );

  it.effect("reparses image publications when the authoritative workspace changes", () =>
    withWorkspace((root, movedRoot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* fs.writeFileString(path.join(root, "shot.png"), "old workspace image");
        yield* fs.writeFileString(path.join(movedRoot, "shot.png"), "new workspace image");
        yield* addMessage("![Screenshot](./shot.png)");
        const parse = vi.spyOn(AssistantMarkdownFiles, "assistantMarkdownFileReferences");
        expect(
          (yield* linked.readFile({
            cwd: root,
            relativePath: "shot.png",
            linkedThreadId: threadId,
          })).contents,
        ).toBe("old workspace image");
        const records = yield* projections.getThreadRecords(threadId, []);
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make("moved-thread"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...records.thread, worktreePath: movedRoot, updatedAt: now },
        });
        expect(
          (yield* linked.readFile({
            cwd: movedRoot,
            relativePath: "shot.png",
            linkedThreadId: threadId,
          })).contents,
        ).toBe("new workspace image");
        expect(parse).toHaveBeenCalledTimes(2);
        expect(
          (yield* linked
            .resolveFile({ threadId, path: path.join(root, "shot.png") })
            .pipe(Effect.flip))._tag,
        ).toBe("ThreadLinkedFileDeniedError");
      }),
    ),
  );

  it.effect("authorizes only the root file when a bare filename exists at the root", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        yield* fs.makeDirectory(path.join(root, "docs"));
        yield* fs.writeFileString(path.join(root, "docs", "report.md"), "nested report");
        yield* fs.writeFileString(path.join(root, "report.md"), "root report");
        yield* addMessage("[Report](report.md)");
        expect(
          (yield* linked.readFile({
            cwd: root,
            relativePath: "report.md",
            linkedThreadId: threadId,
          })).contents,
        ).toBe("root report");
        expect(
          (yield* linked
            .readFile({
              cwd: root,
              relativePath: "docs/report.md",
              linkedThreadId: threadId,
            })
            .pipe(Effect.flip))._tag,
        ).toBe("ThreadLinkedFileDeniedError");
        expect(
          (yield* linked
            .resolveFile({ threadId, path: path.join(root, "docs", "report.md") })
            .pipe(Effect.flip))._tag,
        ).toBe("ThreadLinkedFileDeniedError");
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "never serves an outside file selected by a bare filename lookup",
    () =>
      withWorkspace((root, outside) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
          yield* fs.makeDirectory(path.join(root, "docs"));
          yield* fs.writeFileString(path.join(outside, "private.md"), "private");
          yield* fs.symlink(path.join(outside, "private.md"), path.join(root, "docs", "report.md"));
          yield* addMessage("[Report](report.md)");
          const error = yield* linked
            .readFile({ cwd: root, relativePath: "report.md", linkedThreadId: threadId })
            .pipe(Effect.flip);
          expect(error._tag).toBe("ThreadLinkedFileDeniedError");
        }),
      ),
  );

  it.effect("resolves a published bare filename when the root file is absent", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        yield* fs.makeDirectory(path.join(root, "docs"));
        yield* fs.writeFileString(
          path.join(root, "docs", "report.md"),
          "nested assistant artifact",
        );
        yield* addMessage("[Report](report.md)");
        const result = yield* linked.readFile({
          cwd: root,
          relativePath: "report.md",
          linkedThreadId: threadId,
        });
        expect(result.contents).toBe("nested assistant artifact");
        expect(result.relativePath).toBe("docs/report.md");
      }),
    ),
  );

  it.effect("authorizes only the selected nested file when a bare filename has duplicates", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        const candidates = ["docs/report.md", "private/report.md"];
        for (const candidate of candidates) {
          yield* fs.makeDirectory(path.dirname(path.join(root, candidate)));
          yield* fs.writeFileString(path.join(root, candidate), candidate);
        }
        yield* addMessage("[Report](report.md)");
        const result = yield* linked.readFile({
          cwd: root,
          relativePath: "report.md",
          linkedThreadId: threadId,
        });
        expect(candidates).toContain(result.relativePath);
        expect(result.contents).toBe(result.relativePath);
        expect(
          (yield* linked.readFile({
            cwd: root,
            relativePath: result.relativePath,
            linkedThreadId: threadId,
          })).contents,
        ).toBe(result.contents);
        expect(
          (yield* linked.resolveFile({
            threadId,
            path: path.join(root, result.relativePath),
          })).absolutePath,
        ).toBe(yield* fs.realPath(path.join(root, result.relativePath)));
        const other = candidates.find((candidate) => candidate !== result.relativePath)!;
        expect(
          (yield* linked
            .readFile({ cwd: root, relativePath: other, linkedThreadId: threadId })
            .pipe(Effect.flip))._tag,
        ).toBe("ThreadLinkedFileDeniedError");
        expect(
          (yield* linked.resolveFile({ threadId, path: path.join(root, other) }).pipe(Effect.flip))
            ._tag,
        ).toBe("ThreadLinkedFileDeniedError");
      }),
    ),
  );

  it.effect.each(["bare", "explicit"])("reports an absent authored %s file", (syntax) =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        yield* addMessage(`[Report](${syntax === "bare" ? "report.md" : "./report.md"})`);
        expect(
          (yield* linked
            .readFile({ cwd: root, relativePath: "report.md", linkedThreadId: threadId })
            .pipe(Effect.flip))._tag,
        ).toBe(
          syntax === "bare" ? "ThreadLinkedFileDeniedError" : "ThreadLinkedFileResolutionError",
        );
      }),
    ),
  );

  it.effect.each(["bare", "relative-explicit", "absolute-explicit"])(
    "applies filename lookup only to authored %s links",
    (syntax) =>
      withWorkspace((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
          yield* fs.makeDirectory(path.join(root, "docs"));
          yield* fs.writeFileString(path.join(root, "docs", "report.md"), "chosen filename match");
          yield* addMessage(
            `[Report](${syntax === "bare" ? "report.md" : syntax === "relative-explicit" ? "./report.md" : path.join(root, "report.md")})`,
          );
          const read = linked.readFile({
            cwd: root,
            relativePath: "docs/report.md",
            linkedThreadId: threadId,
          });
          if (syntax === "bare") expect((yield* read).contents).toBe("chosen filename match");
          else expect((yield* read.pipe(Effect.flip))._tag).toBe("ThreadLinkedFileDeniedError");
        }),
      ),
  );

  it.effect.each([
    "absolute-line",
    "relative",
    "relative-line",
    "angle-spaces",
    "file-uri",
    "percent-encoded",
    "reference",
    "quoted",
    "nested-label",
    "multiline",
    "inline-code-file",
    "inline-code-line",
    "image",
    "image-reference",
    "html-link",
    "html-image",
    "codex-citation",
    "query",
    "anchor",
    "encoded-literal-percent",
    "encoded-literal-hash",
  ])("reads the assistant-linked file using %s", (syntax) =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        const name =
          syntax === "encoded-literal-percent"
            ? "report%20.md"
            : syntax === "encoded-literal-hash"
              ? "report#L12.md"
              : syntax === "image" || syntax === "image-reference" || syntax === "html-image"
                ? "screenshot.png"
                : syntax === "angle-spaces" || syntax === "percent-encoded"
                  ? "report file.md"
                  : "report.md";
        const file = path.join(root, name);
        yield* fs.writeFileString(file, "existing assistant artifact");
        const destination =
          syntax === "absolute-line"
            ? `${file}:66`
            : syntax === "relative-line"
              ? `${name}:66`
              : syntax === "query"
                ? `${name}?view=1`
                : syntax === "anchor"
                  ? `${name}#section`
                  : syntax.startsWith("encoded-literal-")
                    ? encodeURI(file).replaceAll("#", "%23")
                    : syntax === "angle-spaces"
                      ? `<${file}:66>`
                      : syntax === "file-uri"
                        ? `file://${file}`
                        : syntax === "percent-encoded"
                          ? encodeURI(file)
                          : name;
        yield* addMessage(
          syntax === "inline-code-file"
            ? `\`./${name}\``
            : syntax === "inline-code-line"
              ? `\`${name}:66\``
              : syntax === "html-link"
                ? `<a href="${destination}">Report</a>`
                : syntax === "html-image"
                  ? `<img src="${destination}">`
                  : syntax === "image"
                    ? `![Screenshot](${destination})`
                    : syntax === "image-reference"
                      ? `![Screenshot][artifact]\n\n[artifact]: ${destination}`
                      : syntax === "codex-citation"
                        ? `:codex-file-citation{path="${file}" line_range_start="66"}`
                        : syntax === "reference"
                          ? `[Report][artifact]\n\n[artifact]: ${destination}`
                          : syntax === "quoted"
                            ? `> [Report](${destination})`
                            : syntax === "nested-label"
                              ? `[Report [details]](${destination})`
                              : syntax === "multiline"
                                ? `[Report](\n${destination}\n)`
                                : `[Report](${destination})`,
        );
        const result = yield* linked.readFile({
          cwd: root,
          relativePath: file,
          linkedThreadId: threadId,
        });
        expect(result.contents).toBe("existing assistant artifact");
      }),
    ),
  );

  it.effect.each([
    "unlinked",
    "user-only",
    "fenced",
    "tilde-fenced",
    "inline-code",
    "indented-code",
    "image-only",
    "unused-definition",
    "html-comment",
    "directory",
    "outside",
    "cwd-spoof",
  ])("denies %s files", (scenario) =>
    withWorkspace((root, outside) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        const file = path.join(scenario === "outside" ? outside : root, "report.md");
        if (scenario === "directory") yield* fs.makeDirectory(file);
        else yield* fs.writeFileString(file, "private");
        const markdown = `[Report](${file}:66)`;
        yield* addMessage(
          scenario === "unlinked"
            ? "No linked report"
            : scenario === "fenced"
              ? `\`\`\`markdown\n${markdown}\n\`\`\``
              : scenario === "tilde-fenced"
                ? `~~~markdown\n${markdown}\n~~~`
                : scenario === "inline-code"
                  ? `\`${markdown}\``
                  : scenario === "indented-code"
                    ? `    ${markdown}`
                    : scenario === "image-only"
                      ? `!${markdown}`
                      : scenario === "unused-definition"
                        ? `[artifact]: ${file}`
                        : scenario === "html-comment"
                          ? `<!-- ${markdown} -->`
                          : markdown,
          scenario === "user-only" ? "user" : "assistant",
        );
        const error = yield* linked
          .readFile({
            cwd: scenario === "cwd-spoof" ? outside : root,
            relativePath: file,
            linkedThreadId: threadId,
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ThreadLinkedFileDeniedError");
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("denies a linked symlink escaping the workspace", () =>
    withWorkspace((root, outside) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        const target = path.join(outside, "private.md");
        const alias = path.join(root, "report.md");
        yield* fs.writeFileString(target, "private");
        yield* fs.symlink(target, alias);
        yield* addMessage(`[Report](${alias})`);
        expect((yield* linked.resolveFile({ threadId, path: alias }).pipe(Effect.flip))._tag).toBe(
          "ThreadLinkedFileDeniedError",
        );
      }),
    ),
  );
});
