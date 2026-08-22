import { ActionResumeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ActionResume } from "../../../actionResume/ActionResume.ts";
import { UpdateDrainAdmission } from "../../../updateDrain/UpdateDrainAdmission.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ActionResumeToolkit } from "./tools.ts";

const duringDrain = (message: string) =>
  new ActionResumeError({
    reason: "internal_error",
    message,
  });

const makeHandlers = (admission: UpdateDrainAdmission["Service"]) =>
  ({
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
        return yield* admission
          .admit(
            "action-resume",
            service.value.runProjectActionAndResume(
              {
                threadId: invocation.threadId,
                providerInstanceId: invocation.providerInstanceId,
              },
              actionId,
            ),
          )
          .pipe(
            Effect.catchTags({
              UpdateDrainAdmissionError: (error) => Effect.fail(duringDrain(error.message)),
              UpdateDrainError: (error) => Effect.fail(duringDrain(error.message)),
            }),
          );
      }),
  }) satisfies Parameters<typeof ActionResumeToolkit.toLayer>[0];

export const ActionResumeToolkitHandlersLive = Layer.unwrap(
  UpdateDrainAdmission.pipe(
    Effect.map((admission) => ActionResumeToolkit.toLayer(makeHandlers(admission))),
  ),
);
