import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type ThreadAttention,
  type ThreadDashboardItemInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadLifecycleError extends Schema.TaggedError<ThreadLifecycleError>()(
  "ThreadLifecycleError",
  {
    operation: Schema.Literals([
      "archive",
      "unarchive",
      "delete",
      "update-metadata",
      "set-runtime-mode",
      "set-interaction-mode",
      "set-model-selection",
      "set-persistence",
      "upsert-annotation",
      "resolve-annotation",
      "reopen-annotation",
      "set-attention",
      "clear-attention",
      "upsert-dashboard-item",
      "remove-dashboard-item",
    ]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread lifecycle operation '${this.operation}' failed for ${this.threadId}.`;
  }
}

export class ThreadLifecycleService extends Context.Service<
  ThreadLifecycleService,
  {
    readonly setPersistence: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly persistent: boolean;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly upsertAnnotation: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly body: string;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly resolveAnnotation: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly reopenAnnotation: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setAttention: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly attention: ThreadAttention;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly clearAttention: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly upsertDashboardItem: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly item: ThreadDashboardItemInput;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly removeDashboardItem: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly itemId: string;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly archive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly childDisposition?: "archive_if_idle" | "archive_after_review" | "stop_and_archive";
      readonly expectedChildThreadIds?: ReadonlyArray<ThreadId>;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly unarchive: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly delete: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly updateMetadata: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setRuntimeMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setInteractionMode: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly interactionMode: ProviderInteractionMode;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
    readonly setModelSelection: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "thread">, ThreadLifecycleError>;
  }
>()("t3/orchestration-v2/ThreadLifecycleService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const dispatch = <Operation extends ThreadLifecycleError["operation"]>(
    operation: Operation,
    threadId: ThreadId,
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.andThen(threads.getThreadRecords(threadId, [])),
      Effect.mapError((cause) => new ThreadLifecycleError({ operation, threadId, cause })),
    );

  return ThreadLifecycleService.of({
    setPersistence: (input) =>
      dispatch("set-persistence", input.threadId, { type: "thread.persistence.set", ...input }),
    upsertAnnotation: (input) =>
      dispatch("upsert-annotation", input.threadId, { type: "thread.annotation.upsert", ...input }),
    resolveAnnotation: (input) =>
      dispatch("resolve-annotation", input.threadId, {
        type: "thread.annotation.resolve",
        ...input,
      }),
    reopenAnnotation: (input) =>
      dispatch("reopen-annotation", input.threadId, { type: "thread.annotation.reopen", ...input }),
    setAttention: (input) =>
      dispatch("set-attention", input.threadId, { type: "thread.attention.set", ...input }),
    clearAttention: (input) =>
      dispatch("clear-attention", input.threadId, { type: "thread.attention.clear", ...input }),
    upsertDashboardItem: (input) =>
      dispatch("upsert-dashboard-item", input.threadId, {
        type: "thread.dashboard-item.upsert",
        ...input,
      }),
    removeDashboardItem: (input) =>
      dispatch("remove-dashboard-item", input.threadId, {
        type: "thread.dashboard-item.remove",
        ...input,
      }),
    archive: (input) =>
      dispatch("archive", input.threadId, {
        type: "thread.archive",
        ...input,
      }),
    unarchive: (input) =>
      dispatch("unarchive", input.threadId, {
        type: "thread.unarchive",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    delete: (input) =>
      dispatch("delete", input.threadId, {
        type: "thread.delete",
        commandId: input.commandId,
        threadId: input.threadId,
      }),
    updateMetadata: (input) =>
      dispatch("update-metadata", input.threadId, {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      }),
    setRuntimeMode: (input) =>
      dispatch("set-runtime-mode", input.threadId, {
        type: "thread.runtime-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
      }),
    setInteractionMode: (input) =>
      dispatch("set-interaction-mode", input.threadId, {
        type: "thread.interaction-mode.set",
        commandId: input.commandId,
        threadId: input.threadId,
        interactionMode: input.interactionMode,
      }),
    setModelSelection: (input) =>
      dispatch("set-model-selection", input.threadId, {
        type: "thread.model-selection.set",
        commandId: input.commandId,
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      }),
  });
});

export const layer = Layer.effect(ThreadLifecycleService, make);
