import { CommandId, EnvironmentId, ProjectId, ProjectMutation, ThreadId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { Caller } from "./threadAccess.ts";
import { planAgentProjectRegistration } from "./projectRegistration.ts";

describe("agent project registration", () => {
  const environmentId = EnvironmentId.make("target");
  const threadId = ThreadId.make("local");
  const sender = {
    environmentId: EnvironmentId.make("source"),
    threadId: ThreadId.make("remote"),
    title: "Source thread",
  };
  const scope = {
    capabilities: new Set<"orchestration">(["orchestration"]),
    environmentId,
    issuedAt: 0,
    requestNamespace: "test",
    thread: undefined,
    client: undefined,
  } satisfies Caller["scope"];

  it("records the local thread even for an ordinary project", () => {
    const local = { id: threadId };
    expect(
      Result.getOrThrow(planAgentProjectRegistration(undefined, { scope, caller: local })),
    ).toEqual({ owner: { environmentId, threadId } });
  });

  it("uses the authenticated sender's environment and thread for a linked registration", () => {
    const client = {
      sessionId: "client",
      label: "Source",
      linked: true,
      access: "full-access",
      senderThread: sender,
    } as const;
    const request = { scope: { ...scope, client }, caller: undefined };
    expect(Result.getOrThrow(planAgentProjectRegistration(true, request))).toEqual({
      owner: { environmentId: sender.environmentId, threadId: sender.threadId },
      temporary: true,
    });
    const outside = { ...request, scope: { ...scope, client: { ...client, linked: false } } };
    expect(Result.getOrThrow(planAgentProjectRegistration(undefined, outside))).toBeUndefined();
    expect(planAgentProjectRegistration(true, outside)).toMatchObject({
      _tag: "Failure",
      failure: { code: "thread_credential_required" },
    });
  });

  it("leaves ownership and temporary creation outside the client mutation contract", () => {
    const decode = Schema.decodeUnknownSync(ProjectMutation);
    const create = {
      type: "project.create",
      projectId: ProjectId.make("project"),
      commandId: CommandId.make("command"),
      title: "Workspace",
      workspaceRoot: "/home/user/workspace",
    };
    expect(
      decode({ ...create, owner: sender, temporary: true, registration: { owner: sender } }),
    ).toEqual(create);
    const update = {
      type: "project.update",
      projectId: create.projectId,
      commandId: create.commandId,
      keepTemporary: true,
    };
    expect(decode({ ...update, owner: sender, temporary: true })).toEqual(update);
    expect(() => decode({ ...update, keepTemporary: false })).toThrow();
  });
});
