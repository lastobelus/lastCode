import * as Capacity from "../../../capacity/Capacity.ts";
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
      const result = yield* service.value.runProjectActionAndResume(
        {
          threadId: invocation.thread.threadId,
          providerInstanceId: invocation.thread.providerInstanceId,
          ...(invocation.thread.subagent !== true || invocation.thread.execution === undefined
            ? {}
            : { source: invocation.thread.execution }),
        },
        actionId,
      );
      return { ...result, capacity: yield* (yield* Capacity.Capacity).read };
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
  resume_interrupted_action: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("action-resume");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "resume_interrupted_action",
      );
      const service = yield* Effect.serviceOption(ActionResume);
      if (Option.isNone(service)) {
        return yield* new ActionResumeError({
          reason: "internal_error",
          message: "Action resume is unavailable in this server runtime.",
        });
      }
      yield* service.value.resumeInterrupted(invocation.thread.threadId);
      return { resumed: true as const };
    }),
  ),
  discard_interrupted_action: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("action-resume");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "discard_interrupted_action",
      );
      const service = yield* Effect.serviceOption(ActionResume);
      if (Option.isNone(service)) {
        return yield* new ActionResumeError({
          reason: "internal_error",
          message: "Action resume is unavailable in this server runtime.",
        });
      }
      yield* service.value.discardInterrupted(invocation.thread.threadId);
      return { discarded: true as const };
    }),
  ),
});
