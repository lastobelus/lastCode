import {
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadArchiveFamily,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { captureLinkedArchiveOperations } from "../../../orchestration-v2/LastCodeLinkedArchiveOperations.ts";
import {
  captureLinkedArchivePreview,
  withLinkedArchivePreview,
} from "../../../orchestration-v2/LastCodeLinkedArchivePreview.ts";
import type { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { fencingLinkOrigin } from "../../linkOrigin.ts";
import { dispatchFailure, type Caller } from "../../threadAccess.ts";

type ArchiveCaller = Pick<Caller, "caller" | "scope">;

export const capture = Effect.gen(function* () {
  const preview = yield* captureLinkedArchivePreview;
  const operations = yield* captureLinkedArchiveOperations;
  return {
    preview: (
      threadId: ThreadId,
      family: OrchestrationV2ThreadArchiveFamily,
      caller: ArchiveCaller,
    ) => withLinkedArchivePreview(threadId, family, caller, preview),
    dispatch: Effect.fn("LastCodeLinkedArchiveTools.dispatch")(function* (
      command: OrchestrationV2Command,
      caller: ArchiveCaller,
      threads: Pick<ThreadManagementService["Service"], "dispatch">,
    ) {
      const local = threads.dispatch(command);
      const isArchive = command.type === "thread.archive";
      if (!isArchive && command.type !== "thread.unarchive") {
        const { sequence } = yield* local.pipe(Effect.mapError(dispatchFailure));
        return { sequence };
      }
      if (fencingLinkOrigin(caller) !== undefined) {
        if (
          command.expectedLinkedArchiveCommandId !== undefined ||
          (isArchive && command.linkedArchiveSelection !== undefined)
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This linked caller cannot archive or restore work on another environment.",
          });
        const { sequence } = yield* local.pipe(Effect.mapError(dispatchFailure));
        return { sequence };
      }
      const { sequence } = yield* operations
        .dispatch(command, local)
        .pipe(Effect.mapError(dispatchFailure));
      const linkedArchiveOperations = yield* operations
        .status(command.threadId)
        .pipe(Effect.orElseSucceed(() => []));
      return {
        sequence,
        ...(linkedArchiveOperations.length === 0 ? {} : { linkedArchiveOperations }),
      };
    }),
  };
});

export type LinkedArchiveTools = Effect.Success<typeof capture>;
