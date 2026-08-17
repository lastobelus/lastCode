import { ActionResumeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ActionResume } from "../../../actionResume/ActionResume.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ActionResumeToolkit } from "./tools.ts";

const handlers = {
  list_project_actions: () =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireMcpCapability("action-resume");
      const service = yield* Effect.serviceOption(ActionResume);
      if (Option.isNone(service)) {
        return yield* new ActionResumeError({
          reason: "internal_error",
          message: "Action resume is unavailable in this server runtime.",
        });
      }
      const actions = yield* service.value.listProjectActions({
        threadId: invocation.threadId,
        providerInstanceId: invocation.providerInstanceId,
      });
      return { actions };
    }),
  run_project_action_and_resume: ({ actionId }) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireMcpCapability("action-resume");
      const service = yield* Effect.serviceOption(ActionResume);
      if (Option.isNone(service)) {
        return yield* new ActionResumeError({
          reason: "internal_error",
          message: "Action resume is unavailable in this server runtime.",
        });
      }
      return yield* service.value.runProjectActionAndResume(
        {
          threadId: invocation.threadId,
          providerInstanceId: invocation.providerInstanceId,
        },
        actionId,
      );
    }),
} satisfies Parameters<typeof ActionResumeToolkit.toLayer>[0];

export const ActionResumeToolkitHandlersLive = ActionResumeToolkit.toLayer(handlers);
