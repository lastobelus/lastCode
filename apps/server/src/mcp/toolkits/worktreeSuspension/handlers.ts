import * as Effect from "effect/Effect";
import { WorktreeSuspension } from "../../../workspace/WorktreeSuspension.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorktreeSuspensionToolkit } from "./tools.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "../../threadAccess.ts";

const service = McpInvocationContext.requireMcpCapability("worktree").pipe(
  Effect.andThen(WorktreeSuspension),
);

const savedWorkspaceAccess = Effect.fn("WorktreeSuspension.mcpAccess")(
  function* () {
    const caller = yield* readCaller();
    yield* assertLiveCaller(caller);
    yield* assertFullAccess(caller, "Orphan recovery requires environment administration access.");
    return { allowOrphans: true };
  },
  Effect.orElseSucceed(() => ({ allowOrphans: false })),
);

export const layer = McpToolAccess.toLayer(WorktreeSuspensionToolkit, {
  t3_worktree_saved_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const value = yield* service;
      return yield* value.list(input, yield* savedWorkspaceAccess());
    }),
  ),
  t3_worktree_suspend_preview: McpToolAccess.writesEnvironment((input) =>
    service.pipe(Effect.flatMap((value) => value.previewSuspend(input))),
  ),
  t3_worktree_suspend: McpToolAccess.writesEnvironment((input) =>
    service.pipe(Effect.flatMap((value) => value.suspend(input))),
  ),
  t3_worktree_restore: McpToolAccess.writesEnvironment((input) =>
    service.pipe(Effect.flatMap((value) => value.restore(input, { allowOrphans: true }))),
  ),
  t3_worktree_discard_preview: McpToolAccess.writesEnvironment((input) =>
    service.pipe(Effect.flatMap((value) => value.previewDiscard(input))),
  ),
  t3_worktree_discard_saved: McpToolAccess.writesEnvironment((input) =>
    service.pipe(Effect.flatMap((value) => value.discard(input))),
  ),
  t3_worktree_keep: McpToolAccess.writesEnvironment((input) =>
    service.pipe(
      Effect.flatMap((value) => value.setKeepWorkspace(input.workspace, { allowOrphans: true })),
    ),
  ),
  t3_worktree_create_fresh: McpToolAccess.writesEnvironment((input) =>
    service.pipe(Effect.flatMap((value) => value.createFresh(input))),
  ),
});
