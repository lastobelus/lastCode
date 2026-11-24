import { ActionResumeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ActionResume } from "../../../actionResume/ActionResume.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ActionResumeToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ActionResumeToolkit, {
  list_project_actions: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("action-resume");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "list_project_actions",
      );
      const service = yield* Effect.serviceOption(ActionResume);
      if (Option.isNone(service)) {
        return yield* new ActionResumeError({
          reason: "internal_error",
          message: "Action resume is unavailable in this server runtime.",
        });
      }
      const actions = yield* service.value.listProjectActions({
        threadId: invocation.thread.threadId,
        providerInstanceId: invocation.thread.providerInstanceId,
      });
      return { actions };
    }),
  ),
  run_project_action_and_resume: McpToolAccess.actsAsCaller(({ actionId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("action-resume");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "run_project_action_and_resume",
      );
      const service = yield* Effect.serviceOption(ActionResume);
      if (Option.isNone(service)) {
        return yield* new ActionResumeError({
          reason: "internal_error",
          message: "Action resume is unavailable in this server runtime.",
        });
      }
      return yield* service.value.runProjectActionAndResume(
        {
          threadId: invocation.thread.threadId,
          providerInstanceId: invocation.thread.providerInstanceId,
        },
        actionId,
      );
    }),
  ),
  inspect_action_run: McpToolAccess.readsAsCaller(({ runId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("action-resume");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "inspect_action_run",
      );
      const service = yield* Effect.serviceOption(ActionResume);
      if (Option.isNone(service)) {
        return yield* new ActionResumeError({
          reason: "internal_error",
          message: "Action resume is unavailable in this server runtime.",
        });
      }
      return yield* service.value.inspectActionRun(
        {
          threadId: invocation.thread.threadId,
          providerInstanceId: invocation.thread.providerInstanceId,
        },
        runId,
      );
    }),
  ),
});
