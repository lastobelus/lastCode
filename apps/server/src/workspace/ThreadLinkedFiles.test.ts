import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as AssistantMarkdownFiles from "@t3tools/shared/assistantMarkdownFiles";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

const withWorkspace = <E, EProjection = never>(
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
  directory?: string,
  projectionLayer: Layer.Layer<
    ProjectionStore.ProjectionStoreV2,
    EProjection
  > = ProjectionStore.layerMemory,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-linked-project-",
      directory,
    });
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
      Layer.provideMerge(projectionLayer),
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
  runId: RunId | null = null,
  rendered = true,
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
      runId,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (rendered)
    yield* projections.apply({
      id: EventId.make(`item-event-${id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item-${id}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* projections.getNextTurnItemOrdinal(threadId),
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        ...(role === "assistant"
          ? { type: "assistant_message" as const, messageId: id, text, streaming: false }
          : {
              type: "user_message" as const,
              messageId: id,
              text,
              attachments: [],
              createdBy: "user" as const,
              creationSource: "web" as const,
              inputIntent: "turn_start" as const,
            }),
      },
    });
});

const addPlan = Effect.fn("addPlan")(function* (
  markdown: string,
  inTurnItem = false,
  runId: RunId | null = null,
  planId = PlanId.make("published-plan"),
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const nodeId = NodeId.make(`node-${planId}`);
  yield* projections.apply({
    id: EventId.make("published-plan-event"),
    type: "plan.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: planId,
      threadId,
      runId,
      nodeId,
      kind: "proposed_plan",
      status: "completed",
      markdown: inTurnItem ? "" : markdown,
      ...(inTurnItem ? { detailInTurnItem: true } : {}),
    },
  });
  yield* projections.apply({
    id: EventId.make("published-plan-item-event"),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item-${planId}`),
      threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* projections.getNextTurnItemOrdinal(threadId),
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
  it.effect.each(["memory", "sqlite"])(
    "revokes cached publications when the active thread is deleted, preserving active forks (%s)",
    (store) =>
      withWorkspace(
        (root, outside) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const base = yield* projections.getThread(threadId);
            const now = yield* DateTime.now;
            const runId = RunId.make("deletion-run");
            yield* projections.apply({
              id: EventId.make("deletion-run-created"),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: base.providerInstanceId,
                modelSelection: base.modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make("deletion-user"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            });
            const hostFile = path.join(outside, "published.md");
            yield* fs.writeFileString(hostFile, "published host file");
            yield* fs.writeFileString(path.join(root, "plan.md"), "published plan file");
            yield* addMessage(
              `[Host file](${hostFile})`,
              "assistant",
              MessageId.make("deletion-assistant"),
              runId,
            );
            yield* addPlan("[Plan file](./plan.md)", true, runId, PlanId.make("deletion-plan"));
            const childId = ThreadId.make("deletion-fork");
            yield* projections.apply({
              id: EventId.make("deletion-fork-created"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: {
                ...base,
                id: childId,
                forkedFrom: { type: "run", threadId, runId },
                lineage: {
                  parentThreadId: threadId,
                  relationshipToParent: "fork",
                  rootThreadId: threadId,
                },
              },
            });
            const publications = [
              [hostFile, "published host file"],
              ["plan.md", "published plan file"],
            ] as const;
            for (const owner of [threadId, childId]) {
              for (const [file, contents] of publications) {
                expect(
                  (yield* linked.readFile({ cwd: root, relativePath: file, linkedThreadId: owner }))
                    .contents,
                ).toBe(contents);
                yield* linked.resolveFile({ cwd: root, threadId: owner, path: file });
              }
            }
            // Archive keeps the conversation available; only deletion revokes its grants.
            const archived = {
              ...(yield* projections.getThread(threadId)),
              archivedAt: now,
              updatedAt: now,
            };
            yield* projections.apply({
              id: EventId.make("deletion-thread-archived"),
              type: "thread.archived",
              threadId,
              occurredAt: now,
              payload: archived,
            });
            expect(
              (yield* linked.readFile({
                cwd: root,
                relativePath: hostFile,
                linkedThreadId: threadId,
              })).contents,
            ).toBe("published host file");
            yield* projections.apply({
              id: EventId.make("deletion-thread-deleted"),
              type: "thread.deleted",
              threadId,
              occurredAt: now,
              payload: { ...archived, deletedAt: now },
            });
            expect(
              (yield* projections.getVisiblePublications(threadId).pipe(Effect.flip))._tag,
            ).toBe("ProjectionStoreThreadNotFoundError");
            for (const [file, contents] of publications) {
              const readError = yield* linked
                .readFile({ cwd: root, relativePath: file, linkedThreadId: threadId })
                .pipe(Effect.flip);
              expect(readError).toBeInstanceOf(ThreadLinkedFiles.ThreadLinkedFileResolutionError);
              expect(
                (yield* linked.resolveFile({ cwd: root, threadId, path: file }).pipe(Effect.flip))
                  ._tag,
              ).toBe("ThreadLinkedFileResolutionError");
              // Deletion of an ancestor must not remove cards still displayed by its active fork.
              expect(
                (yield* linked.readFile({ cwd: root, relativePath: file, linkedThreadId: childId }))
                  .contents,
              ).toBe(contents);
              expect(
                (yield* linked.resolveFile({ cwd: root, threadId: childId, path: file }))
                  .absolutePath,
              ).toBe(yield* fs.realPath(path.resolve(root, file)));
            }
            const inherited = yield* projections.getVisiblePublications(childId);
            expect(inherited.thread.deletedAt).toBeNull();
            expect(inherited.publications).toHaveLength(2);
            expect(inherited.publications.every((row) => row.sourceThreadId === threadId)).toBe(
              true,
            );
          }),
        undefined,
        store === "sqlite"
          ? ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))
          : ProjectionStore.layerMemory,
      ),
  );

  it.effect.each(["memory", "sqlite"])(
    "revokes cached assistant and plan links after persisted rollback (%s)",
    (store) =>
      withWorkspace(
        (root) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const base = yield* projections.getThread(threadId);
            const now = yield* DateTime.now;
            const createRun = Effect.fn(function* (ordinal: number) {
              const run = {
                id: RunId.make(`rollback-run-${ordinal}`),
                threadId,
                ordinal,
                providerInstanceId: base.providerInstanceId,
                modelSelection: base.modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`rollback-user-${ordinal}`),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed" as const,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              };
              yield* projections.apply({
                id: EventId.make(`created-${run.id}`),
                type: "run.created",
                threadId,
                occurredAt: now,
                payload: run,
              });
              return run;
            });
            const remaining = yield* createRun(1);
            const rolledBack = yield* createRun(2);
            const assistantId = MessageId.make("rollback-assistant");
            const planId = PlanId.make("rollback-plan");
            const files = [
              "visible-assistant.md",
              "visible-plan.md",
              "rolled-assistant.md",
              "rolled-plan.md",
            ];
            for (const file of files) yield* fs.writeFileString(path.join(root, file), file);
            yield* addMessage(
              "[Visible](./visible-assistant.md)",
              "assistant",
              MessageId.make("remaining-assistant"),
              remaining.id,
            );
            yield* addPlan(
              "[Visible plan](./visible-plan.md)",
              false,
              remaining.id,
              PlanId.make("remaining-plan"),
            );
            yield* addMessage(
              "[Rolled back](./rolled-assistant.md)",
              "assistant",
              assistantId,
              rolledBack.id,
            );
            yield* addPlan("[Rolled back plan](./rolled-plan.md)", true, rolledBack.id, planId);
            const childId = ThreadId.make("rollback-fork");
            yield* projections.apply({
              id: EventId.make("rollback-fork-created"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: {
                ...base,
                id: childId,
                forkedFrom: { type: "run", threadId, runId: rolledBack.id },
                lineage: {
                  parentThreadId: threadId,
                  relationshipToParent: "fork",
                  rootThreadId: threadId,
                },
              },
            });
            for (const file of files) {
              expect(
                (yield* linked.readFile({
                  cwd: root,
                  relativePath: file,
                  linkedThreadId: threadId,
                })).contents,
              ).toBe(file);
            }
            // The checkpoint rollback commits run.updated; it hides items without deleting their bodies.
            yield* projections.apply({
              id: EventId.make("rollback-completed"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...rolledBack, status: "rolled_back" },
            });
            const retained = yield* projections.getThreadRecords(threadId, [
              "messages",
              "plans",
              "turnItems",
            ]);
            expect(retained.messages.some((message) => message.id === assistantId)).toBe(true);
            expect(retained.plans.some((plan) => plan.id === planId)).toBe(true);
            expect(retained.turnItems.filter((item) => item.runId === rolledBack.id)).toHaveLength(
              2,
            );
            const visible = yield* projections.getTimelinePage(threadId, {
              limit: 20,
              view: "messages",
            });
            expect(visible.items.some((row) => row.item.runId === rolledBack.id)).toBe(false);
            expect(visible.items.filter((row) => row.item.runId === remaining.id)).toHaveLength(2);
            // Both text reads and fresh media resolutions must reject previously cached publications.
            for (const file of files.slice(2)) {
              expect(
                (yield* linked
                  .readFile({ cwd: root, relativePath: file, linkedThreadId: threadId })
                  .pipe(Effect.flip))._tag,
              ).toBe("ThreadLinkedFileDeniedError");
              expect(
                (yield* linked.resolveFile({ cwd: root, threadId, path: file }).pipe(Effect.flip))
                  ._tag,
              ).toBe("ThreadLinkedFileDeniedError");
            }
            for (const file of files.slice(0, 2)) {
              expect(
                (yield* linked.readFile({
                  cwd: root,
                  relativePath: file,
                  linkedThreadId: threadId,
                })).contents,
              ).toBe(file);
            }
            // The fork still displays this snapshot even after the source thread rolls back.
            const childVisible = yield* projections.getTimelinePage(childId, {
              limit: 20,
              view: "messages",
            });
            expect(
              childVisible.items.filter((row) => row.item.runId === rolledBack.id),
            ).toHaveLength(2);
            for (const file of files.slice(2)) {
              expect(
                (yield* linked.readFile({ cwd: root, relativePath: file, linkedThreadId: childId }))
                  .contents,
              ).toBe(file);
            }
          }),
        undefined,
        store === "sqlite"
          ? ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))
          : ProjectionStore.layerMemory,
      ),
  );

  it.effect("does not publish retained local records without displayed items", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        yield* fs.writeFileString(path.join(root, "orphan.md"), "not displayed");
        yield* addMessage(
          "[Orphan](./orphan.md)",
          "assistant",
          MessageId.make("orphan-message"),
          null,
          false,
        );
        yield* projections.apply({
          id: EventId.make("orphan-plan-event"),
          type: "plan.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: PlanId.make("orphan-plan"),
            threadId,
            runId: null,
            nodeId: NodeId.make("orphan-node"),
            kind: "proposed_plan",
            status: "completed",
            markdown: "[Orphan plan](./orphan.md)",
          },
        });
        expect(
          (yield* linked.resolveFile({ threadId, path: "orphan.md" }).pipe(Effect.flip))._tag,
        ).toBe("ThreadLinkedFileDeniedError");
        yield* addMessage("[Displayed](./orphan.md)");
        expect(
          (yield* linked.readFile({
            cwd: root,
            relativePath: "orphan.md",
            linkedThreadId: threadId,
          })).contents,
        ).toBe("not displayed");
      }),
    ),
  );

  it.effect.each(["memory", "sqlite"])(
    "reads only visible inherited publications through nested fork cutoffs (%s)",
    (store) =>
      withWorkspace(
        (root) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const base = yield* projections.getThread(threadId);
            const childId = ThreadId.make("linked-child");
            const leafId = ThreadId.make("linked-leaf");
            const unrelatedId = ThreadId.make("linked-unrelated");
            const childRoot = path.resolve(root, "../child-worktree");
            const leafRoot = path.resolve(root, "../leaf-worktree");
            const createThread = Effect.fn(function* (
              id: ThreadId,
              cwd: string,
              fork?: { threadId: ThreadId; runId: RunId },
            ) {
              const now = yield* DateTime.now;
              yield* fs.makeDirectory(cwd, { recursive: true });
              yield* projections.apply({
                id: EventId.make(`created-${id}`),
                type: "thread.created",
                threadId: id,
                occurredAt: now,
                payload: {
                  ...base,
                  id,
                  worktreePath: cwd,
                  createdAt: now,
                  updatedAt: now,
                  forkedFrom: fork === undefined ? null : { type: "run", ...fork },
                  lineage: {
                    parentThreadId: fork?.threadId ?? null,
                    relationshipToParent: fork === undefined ? null : "fork",
                    rootThreadId: fork === undefined ? id : threadId,
                  },
                },
              });
            });
            const createRun = Effect.fn(function* (owner: ThreadId, ordinal: number) {
              const now = yield* DateTime.now;
              const id = RunId.make(`run-${owner}-${ordinal}`);
              yield* projections.apply({
                id: EventId.make(`created-${id}`),
                type: "run.created",
                threadId: owner,
                occurredAt: now,
                payload: {
                  id,
                  threadId: owner,
                  ordinal,
                  providerInstanceId: base.providerInstanceId,
                  modelSelection: base.modelSelection,
                  providerThreadId: null,
                  userMessageId: MessageId.make(`user-${id}`),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "completed",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: now,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              });
              return id;
            });
            const publish = Effect.fn(function* (
              owner: ThreadId,
              runId: RunId,
              id: TurnItemId,
              text: string,
              kind: "assistant_message" | "proposed_plan" | "user_message" = "assistant_message",
            ) {
              const now = yield* DateTime.now;
              const detail =
                kind === "proposed_plan"
                  ? {
                      type: "proposed_plan" as const,
                      planId: PlanId.make(`plan-${id}`),
                      markdown: text,
                      streaming: false,
                    }
                  : kind === "user_message"
                    ? {
                        type: "user_message" as const,
                        messageId: MessageId.make(`message-${id}`),
                        text,
                        attachments: [],
                        createdBy: "user" as const,
                        creationSource: "web" as const,
                        inputIntent: "turn_start" as const,
                      }
                    : {
                        type: "assistant_message" as const,
                        messageId: MessageId.make(`message-${id}`),
                        text,
                        streaming: false,
                      };
              yield* projections.apply({
                id: EventId.make(`updated-${id}`),
                type: "turn-item.updated",
                threadId: owner,
                occurredAt: now,
                payload: {
                  id,
                  threadId: owner,
                  runId,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: yield* projections.getNextTurnItemOrdinal(owner),
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  ...detail,
                },
              });
            });
            const parentRun = yield* createRun(threadId, 1);
            const parentLaterRun = yield* createRun(threadId, 2);
            yield* createThread(childId, childRoot, { threadId, runId: parentRun });
            const childRun = yield* createRun(childId, 1);
            const childLaterRun = yield* createRun(childId, 2);
            yield* createThread(leafId, leafRoot, { threadId: childId, runId: childRun });
            yield* createThread(unrelatedId, root);
            const unrelatedRun = yield* createRun(unrelatedId, 1);
            const parentFile = path.join(root, "parent.md");
            const parentLaterFile = path.join(root, "post-fork.md");
            const userFile = path.join(root, "user-only.md");
            const orphanFile = path.join(root, "unrendered.md");
            const unrelatedFile = path.join(root, "unrelated.md");
            const childFile = path.join(childRoot, "visible-child.md");
            const childLaterFile = path.join(childRoot, "post-child-fork.md");
            for (const file of [
              parentFile,
              parentLaterFile,
              userFile,
              orphanFile,
              unrelatedFile,
              childFile,
              childLaterFile,
            ])
              yield* fs.writeFileString(file, "published artifact");
            for (const cwd of [root, childRoot, leafRoot]) {
              yield* fs.writeFileString(path.join(cwd, "relative.md"), cwd);
              yield* fs.writeFileString(path.join(cwd, "plan.md"), "inherited plan artifact");
            }
            const parentItem = TurnItemId.make("parent-publication");
            yield* publish(
              threadId,
              parentRun,
              parentItem,
              `[Parent](${parentFile}) [Relative](./relative.md)`,
            );
            yield* publish(
              threadId,
              parentRun,
              TurnItemId.make("parent-plan"),
              "# Plan\n\n[Artifact](./plan.md)",
              "proposed_plan",
            );
            yield* publish(
              threadId,
              parentRun,
              TurnItemId.make("parent-user"),
              `[User file](${userFile})`,
              "user_message",
            );
            yield* addMessage(
              `[Unrendered](${orphanFile})`,
              "assistant",
              MessageId.make("unrendered-message"),
              null,
              false,
            );
            yield* publish(
              threadId,
              parentLaterRun,
              TurnItemId.make("parent-post-fork"),
              `[Later](${parentLaterFile})`,
            );
            yield* publish(
              threadId,
              parentLaterRun,
              TurnItemId.make("parent-post-fork-plan"),
              `[Later plan](${parentLaterFile})`,
              "proposed_plan",
            );
            yield* publish(
              childId,
              childRun,
              TurnItemId.make("child-publication"),
              `[Child](${childFile})`,
            );
            yield* publish(
              childId,
              childLaterRun,
              TurnItemId.make("child-post-fork"),
              `[Later child](${childLaterFile})`,
            );
            yield* publish(
              unrelatedId,
              unrelatedRun,
              TurnItemId.make("unrelated-publication"),
              `[Other](${unrelatedFile})`,
            );
            for (const [owner, cwd] of [
              [childId, childRoot],
              [leafId, leafRoot],
            ] as const) {
              expect(
                (yield* linked.readFile({ cwd, relativePath: parentFile, linkedThreadId: owner }))
                  .contents,
              ).toBe("published artifact");
              expect(
                (yield* linked.readFile({
                  cwd,
                  relativePath: "relative.md",
                  linkedThreadId: owner,
                })).contents,
              ).toBe(cwd);
              expect(
                (yield* linked.readFile({ cwd, relativePath: "plan.md", linkedThreadId: owner }))
                  .contents,
              ).toBe("inherited plan artifact");
              for (const denied of [
                parentLaterFile,
                userFile,
                orphanFile,
                unrelatedFile,
                path.join(root, "relative.md"),
              ])
                expect(
                  (yield* linked
                    .resolveFile({ cwd, threadId: owner, path: denied })
                    .pipe(Effect.flip))._tag,
                ).toBe("ThreadLinkedFileDeniedError");
            }
            expect(
              (yield* linked.resolveFile({ cwd: leafRoot, threadId: leafId, path: childFile }))
                .absolutePath,
            ).toBe(yield* fs.realPath(childFile));
            expect(
              (yield* linked
                .resolveFile({ threadId: leafId, path: childLaterFile })
                .pipe(Effect.flip))._tag,
            ).toBe("ThreadLinkedFileDeniedError");
            expect(
              (yield* linked
                .resolveFile({ cwd: root, threadId: leafId, path: parentFile })
                .pipe(Effect.flip))._tag,
            ).toBe("ThreadLinkedFileDeniedError");
            yield* publish(threadId, parentRun, parentItem, "The inherited links were removed");
            expect(
              (yield* linked.resolveFile({ threadId: leafId, path: parentFile }).pipe(Effect.flip))
                ._tag,
            ).toBe("ThreadLinkedFileDeniedError");
            expect(
              (yield* linked
                .resolveFile({ threadId: childId, path: "relative.md" })
                .pipe(Effect.flip))._tag,
            ).toBe("ThreadLinkedFileDeniedError");
            const leaf = yield* projections.getThread(leafId);
            const now = yield* DateTime.now;
            yield* projections.apply({
              id: EventId.make("changed-fork-source"),
              type: "thread.metadata-updated",
              threadId: leafId,
              occurredAt: now,
              payload: {
                ...leaf,
                forkedFrom: { type: "run", threadId, runId: parentRun },
                updatedAt: now,
              },
            });
            expect(
              (yield* linked.resolveFile({ threadId: leafId, path: childFile }).pipe(Effect.flip))
                ._tag,
            ).toBe("ThreadLinkedFileDeniedError");
            expect(
              (yield* linked.readFile({
                cwd: leafRoot,
                relativePath: "plan.md",
                linkedThreadId: leafId,
              })).contents,
            ).toBe("inherited plan artifact");
          }),
        undefined,
        store === "sqlite"
          ? ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))
          : ProjectionStore.layerMemory,
      ),
  );

  for (const filename of ["report.md", "report%20.md", "report#L12.md", "report.md:012"]) {
    it.effect.skipIf(
      resolvePathLinkTarget("~/", process.cwd()) === "~/" ||
        (HostProcessPlatform.defaultValue() === "win32" && filename.includes(":")),
    )(`reads the exact home-relative publication ${filename} without reparsing its filename`, () =>
      withWorkspace(
        (root) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
            const home = resolvePathLinkTarget("~/", root);
            const artifactDirectory = path.resolve(root, "../home-artifacts");
            yield* fs.makeDirectory(artifactDirectory);
            const file = path.join(artifactDirectory, filename);
            yield* fs.writeFileString(file, "published home artifact");
            const homePath = `~/${path.relative(home, file).replaceAll("\\", "/")}`;
            const destination = `${encodeURI(homePath).replaceAll("#", "%23")}:66:7`;
            yield* addMessage(`[Report](${destination})`);
            const result = yield* linked.readFile({
              cwd: root,
              relativePath: file,
              linkedThreadId: threadId,
            });
            expect(result.contents).toBe("published home artifact");
            expect(result.relativePath).toBe(file);
            expect((yield* linked.resolveFile({ threadId, path: homePath })).absolutePath).toBe(
              yield* fs.realPath(file),
            );
            const unlinked = path.join(artifactDirectory, "private", filename);
            yield* fs.makeDirectory(path.dirname(unlinked));
            yield* fs.writeFileString(unlinked, "unlinked host file");
            expect(
              (yield* linked.resolveFile({ threadId, path: unlinked }).pipe(Effect.flip))._tag,
            ).toBe("ThreadLinkedFileDeniedError");
            yield* addMessage("The home-relative link was removed");
            expect(
              (yield* linked.resolveFile({ threadId, path: file }).pipe(Effect.flip))._tag,
            ).toBe("ThreadLinkedFileDeniedError");
          }),
        process.cwd(),
      ),
    );
  }

  it.effect.each(["absolute", "relative-outside"])(
    "reads an explicitly published host file using an %s destination",
    (syntax) =>
      withWorkspace((root, outside) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
          const file = path.join(outside, "manual-qa.md");
          yield* fs.writeFileString(file, "published QA steps");
          const destination = syntax === "absolute" ? file : path.relative(root, file);
          yield* addMessage(`[QA steps](${destination}:66)`);
          const canonicalFile = yield* fs.realPath(file);
          const result = yield* linked.readFile({
            cwd: root,
            relativePath: destination,
            linkedThreadId: threadId,
          });
          expect(result.contents).toBe("published QA steps");
          expect(result.relativePath).toBe(file);
          expect(yield* linked.resolveFile({ threadId, path: file, cwd: root })).toEqual({
            cwd: root,
            relativePath: file,
            absolutePath: canonicalFile,
          });
          yield* addMessage("The QA link was removed");
          expect((yield* linked.resolveFile({ threadId, path: file }).pipe(Effect.flip))._tag).toBe(
            "ThreadLinkedFileDeniedError",
          );
        }),
      ),
  );

  it.effect.each(["same-basename", "bare-filename", "directory", "user-only", "cwd-spoof"])(
    "denies an outside host file for %s",
    (scenario) =>
      withWorkspace((root, outside) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
          const published = path.join(outside, "published", "report.md");
          const requested =
            scenario === "same-basename" ? path.join(outside, "private", "report.md") : published;
          yield* fs.makeDirectory(path.dirname(published), { recursive: true });
          yield* fs.makeDirectory(path.dirname(requested), { recursive: true });
          if (scenario === "directory") yield* fs.makeDirectory(requested);
          else yield* fs.writeFileString(requested, "private file");
          yield* addMessage(
            `[Report](${scenario === "bare-filename" ? "report.md" : published})`,
            scenario === "user-only" ? "user" : "assistant",
          );
          const cwd = scenario === "cwd-spoof" ? outside : root;
          expect(
            (yield* linked
              .readFile({ cwd, relativePath: requested, linkedThreadId: threadId })
              .pipe(Effect.flip))._tag,
          ).toBe("ThreadLinkedFileDeniedError");
          expect(
            (yield* linked.resolveFile({ cwd, threadId, path: requested }).pipe(Effect.flip))._tag,
          ).toBe("ThreadLinkedFileDeniedError");
        }),
      ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "reads a published outside alias through its canonical file",
    () =>
      withWorkspace((root, outside) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
          const target = path.join(outside, "artifact.md");
          const alias = path.join(outside, "published.md");
          yield* fs.writeFileString(target, "host artifact");
          yield* fs.symlink(target, alias);
          yield* addMessage(`[Artifact](${alias})`);
          const canonicalFile = yield* fs.realPath(target);
          const result = yield* linked.readFile({
            cwd: root,
            relativePath: alias,
            linkedThreadId: threadId,
          });
          expect(result.contents).toBe("host artifact");
          expect(result.relativePath).toBe(alias);
          expect(
            (yield* linked.resolveFile({ threadId, path: result.relativePath })).absolutePath,
          ).toBe(canonicalFile);
        }),
      ),
  );

  it.effect.each([false, true])(
    "reads a visible plan publication (artifact placeholder: %s)",
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

  it.effect.each(["bare", "relative-explicit", "absolute-explicit"])(
    "does not let a root directory retarget an authored %s path",
    (syntax) =>
      withWorkspace((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
          const rootEntry = path.join(root, "report.md");
          const nestedFile = path.join(root, "docs", "report.md");
          yield* fs.makeDirectory(rootEntry);
          yield* fs.makeDirectory(path.dirname(nestedFile));
          yield* fs.writeFileString(nestedFile, "nested report");
          yield* addMessage(
            `[Report](${syntax === "bare" ? "report.md" : syntax === "relative-explicit" ? "./report.md" : rootEntry})`,
          );
          const read = linked.readFile({
            cwd: root,
            relativePath: "report.md",
            linkedThreadId: threadId,
          });
          if (syntax === "bare") {
            const result = yield* read;
            expect(result.contents).toBe("nested report");
            expect(result.relativePath).toBe("docs/report.md");
            expect(
              (yield* linked.resolveFile({ cwd: root, threadId, path: "report.md" })).absolutePath,
            ).toBe(yield* fs.realPath(nestedFile));
            expect(
              (yield* linked.resolveFile({ cwd: root, threadId, path: result.relativePath }))
                .absolutePath,
            ).toBe(yield* fs.realPath(nestedFile));
          } else {
            expect((yield* read.pipe(Effect.flip))._tag).toBe("ThreadLinkedFileDeniedError");
            for (const file of [rootEntry, nestedFile]) {
              expect(
                (yield* linked.resolveFile({ cwd: root, threadId, path: file }).pipe(Effect.flip))
                  ._tag,
              ).toBe("ThreadLinkedFileDeniedError");
            }
          }
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
    "outside-unlinked",
    "cwd-spoof",
  ])("denies %s files", (scenario) =>
    withWorkspace((root, outside) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const linked = yield* ThreadLinkedFiles.ThreadLinkedFiles;
        const file = path.join(scenario === "outside-unlinked" ? outside : root, "report.md");
        if (scenario === "directory") yield* fs.makeDirectory(file);
        else yield* fs.writeFileString(file, "private");
        const markdown = `[Report](${file}:66)`;
        yield* addMessage(
          scenario === "outside-unlinked"
            ? `[Report](${path.join(root, "report.md")}:66)`
            : scenario === "unlinked"
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
