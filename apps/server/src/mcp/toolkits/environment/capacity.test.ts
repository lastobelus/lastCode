import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Capacity from "../../../capacity/Capacity.ts";
import { unknownCapacitySnapshot } from "../../../capacity/logic.ts";
import * as EnvironmentPause from "../../../environment/EnvironmentPause.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PromptSnippets from "../../../promptSnippets/PromptSnippets.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("capacity-local");
const remoteId = EnvironmentId.make("capacity-remote");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "capacity-client",
  thread: undefined,
  client: { sessionId: "read-only", label: "Read-only client", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const invoke = Effect.fn("test.capacity.invoke")(function* (
  caller: McpInvocationContext.McpInvocationScope,
  includeLinked?: boolean,
) {
  return yield* Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const results = yield* toolkit
      .handle("t3_environment_read", { includeLinked })
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, caller),
            ThreadCommandExecutor.layer,
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(PromptSnippets.PromptSnippets)({}),
            Layer.mock(EnvironmentPause.EnvironmentPause)({}),
            Layer.mock(Environment.ServerEnvironment)({
              getDescriptor: Effect.succeed({
                environmentId,
                label: "Capacity test",
                serverVersion: "0.0.0-test",
                platform: { os: "linux", arch: "x64" },
                capabilities: { repositoryIdentity: false },
              }),
            }),
            Layer.mock(Settings.ServerSettingsService)({
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect("publishes local and linked capacity for a read-only environment client", () =>
  Effect.gen(function* () {
    const local = unknownCapacitySnapshot(1);
    const remote = { ...unknownCapacitySnapshot(2), mode: "off" as const };
    const result = yield* invoke(scope).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Capacity.Capacity, { read: Effect.succeed(local) }),
          Layer.mock(PeerForwarding.PeerForwarding)({
            links: (caller) => {
              expect(caller.client?.access).toBe("read-only");
              return Effect.succeed({
                environmentId,
                notListed: "",
                links: [
                  {
                    environmentId: remoteId,
                    label: "Remote",
                    status: "reachable",
                    access: "read-only",
                    expiresAt: "2099-01-01T00:00:00.000Z",
                    lastError: null,
                  },
                ],
              });
            },
            call: (_caller, _tool, target) => {
              expect(target).toBe(remoteId);
              return Effect.succeed({ capacity: remote }) as never;
            },
          }),
        ),
      ),
    );
    expect(result).toMatchObject({
      preferences: { capacityMode: "observe" },
      capacity: {
        ...local,
        linkedObservation: "known",
        linked: [{ environmentId: remoteId, label: "Remote", capacity: remote }],
      },
    });
  }),
);

it.effect("checks the credential's environment before reading capacity", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make(0);
    const result = yield* invoke({ ...scope, environmentId: remoteId }).pipe(
      Effect.provide(
        Layer.succeed(Capacity.Capacity, {
          read: Ref.update(reads, (count) => count + 1).pipe(Effect.as(unknownCapacitySnapshot(0))),
        }),
      ),
    );
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(yield* Ref.get(reads)).toBe(0);
  }),
);

it.effect("publishes unknown when capacity and forwarding services are absent", () =>
  Effect.gen(function* () {
    expect(yield* invoke(scope)).toMatchObject({
      capacity: {
        linkedObservation: "unknown",
        linked: [],
        verdicts: {
          owner: { state: "open" },
          agent: { state: "unknown" },
          background: { state: "unknown" },
        },
      },
    });
    expect(yield* invoke(scope, false)).toMatchObject({
      capacity: { linkedObservation: "not-requested", linked: [] },
    });
  }),
);
