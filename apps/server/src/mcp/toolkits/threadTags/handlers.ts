import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as ThreadTags from "../../../orchestration-v2/ThreadTags.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { newCommandId } from "../../threadAccess.ts";
import { ThreadTagsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ThreadTagsToolkit, {
  t3_thread_tag_vocabulary: McpToolAccess.reads(
    Effect.fnUntraced(function* (input) {
      yield* McpInvocationContext.requireMcpCapability("orchestration");
      return yield* (yield* ThreadTags.ThreadTags).vocabulary(input);
    }),
  ),
  t3_thread_tag_query: McpToolAccess.reads(
    Effect.fnUntraced(function* (input) {
      const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
      const result = yield* (yield* ThreadTags.ThreadTags).query(input);
      return {
        ...result,
        threads: result.threads.map((thread) => ({
          ...thread,
          environmentId: scope.environmentId,
          link: formatThreadLink(
            { environmentId: scope.environmentId, threadId: thread.id },
            thread.title,
          ),
        })),
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
