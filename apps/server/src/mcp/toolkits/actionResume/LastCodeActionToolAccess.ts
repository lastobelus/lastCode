import { projectActionLaunchDisabled } from "@t3tools/provider-core/server/lastcodeProjectActions";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";

import { McpInvocationContext } from "../../McpInvocationContext.ts";

export function visibleWithProjectActionLaunch(): boolean {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return (
    scope === undefined ||
    (scope.thread !== undefined && !projectActionLaunchDisabled(scope.capabilities))
  );
}
