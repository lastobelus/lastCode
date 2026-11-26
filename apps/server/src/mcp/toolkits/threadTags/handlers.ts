import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as ThreadTags from "../../../orchestration-v2/ThreadTags.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { newCommandId } from "../../threadAccess.ts";
import { ThreadTagsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ThreadTagsToolkit, {
  t3_thread_tags: McpToolAccess.reads(
    Effect.fnUntraced(function* (input) {
      const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
      const service = yield* ThreadTags.ThreadTags;
      if (input.tag === undefined) {
        if (input.mode !== undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "mode requires tag. Add tag to list its threads, or drop mode to list tags.",
          });
        return yield* service.vocabulary(input);
      }
      if (input.query !== undefined || input.preferredProjectId !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "tag cannot be combined with query or preferredProjectId. Drop them to list the tag's threads, or drop tag to search tag names.",
        });
      const result = yield* service.query({ ...input, tag: input.tag });
      return {
        threads: result.threads.map((thread) => ({
          threadId: thread.id,
          projectId: thread.projectId,
          environmentId: scope.environmentId,
          title: thread.title,
          tags: thread.tags ?? [],
          settled: thread.settledOverride === "settled",
          link: McpInvocationContext.threadLinkFor(scope, thread.id, thread.title),
        })),
        nextCursor: result.nextCursor,
      };
    }),
  ),
  t3_thread_tag_set: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    Effect.fnUntraced(function* (input) {
      yield* McpInvocationContext.requireMcpCapability("orchestration");
      return yield* (yield* ThreadTags.ThreadTags).set({
        ...input,
        commandId: yield* newCommandId(),
      });
    }),
  ),
});
