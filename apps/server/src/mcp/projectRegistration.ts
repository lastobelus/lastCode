import {
  OrchestratorMcpFailure,
  type ProjectRegistration,
  type ThreadOwner,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import type { ProjectService } from "../project/ProjectService.ts";
import type { Caller } from "./threadAccess.ts";
import { resolveAgentCreator } from "./threadLaunchOwnership.ts";

export function planAgentProjectRegistration(
  temporary: boolean | undefined,
  {
    caller,
    scope,
  }: {
    readonly caller: Pick<NonNullable<Caller["caller"]>, "id"> | undefined;
    readonly scope: Pick<Caller["scope"], "client" | "environmentId">;
  },
): Result.Result<ProjectRegistration | undefined, OrchestratorMcpFailure> {
  const owner = resolveAgentCreator({
    caller,
    client: scope.client,
    environmentId: scope.environmentId,
  });
  if (owner !== undefined) {
    return Result.succeed(temporary === true ? { owner, temporary: true } : { owner });
  }
  if (temporary === true) {
    return Result.fail(
      new OrchestratorMcpFailure({
        code: "thread_credential_required",
        message:
          "A temporary project needs an owning thread. Register it from a T3 Code thread, or omit temporary to register a permanent project.",
      }),
    );
  }
  return Result.succeed(undefined);
}

export function listAgentProjects(
  projects: ProjectService["Service"],
  input: {
    readonly cursor?: number | undefined;
    readonly limit?: number | undefined;
    readonly temporaryOwner?: ThreadOwner | undefined;
  },
) {
  const page = { cursor: input.cursor ?? 0, limit: input.limit ?? 20 };
  return input.temporaryOwner === undefined
    ? projects.listPage(page)
    : projects.listTemporaryOwnedBy(input.temporaryOwner, page);
}
