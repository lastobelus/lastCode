import {
  linkOriginIsFenced,
  type LinkedArchivePreview,
  type OrchestrationV2ThreadArchiveFamily,
  type PeerArchiveUnavailable,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { fencingLinkOrigin } from "../mcp/linkOrigin.ts";
import { type ClientModes, clientModeCeiling } from "../mcp/McpInvocationContext.ts";
import type { Caller } from "../mcp/threadAccess.ts";
import {
  LastCodePeerArchiveTransport,
  PEER_ARCHIVE_PREVIEW_TIMEOUT_MS,
  PeerArchiveHandler,
} from "../peer/LastCodePeerArchiveServices.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import { captureLinkedArchiveOperations } from "./LastCodeLinkedArchiveOperations.ts";
import {
  readPeerArchiveInventory,
  readPeerArchiveOwnerScope,
} from "./LastCodePeerArchiveInventory.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

export class LastCodeLinkedArchivePreview extends Context.Service<
  LastCodeLinkedArchivePreview,
  {
    readonly load: (
      threadId: ThreadId,
      family: OrchestrationV2ThreadArchiveFamily,
      limits?: ClientModes,
    ) => Effect.Effect<OrchestrationV2ThreadArchiveFamily, OrchestratorProjectionError>;
  }
>()("t3/orchestration-v2/LastCodeLinkedArchivePreview") {}

const offline: PeerArchiveUnavailable = { status: "pending", reason: "offline" };
const denied: PeerArchiveUnavailable = { status: "blocked", reason: "denied" };

export const layerHandler = Layer.effect(
  PeerArchiveHandler,
  Effect.gen(function* () {
    const { getEnvironmentId } = yield* ServerEnvironment;
    const environmentId = yield* getEnvironmentId;
    const store = yield* ProjectionStoreV2;
    const projects = yield* ProjectStoreV2;

    return PeerArchiveHandler.of({
      inventory: Effect.fn("LastCodeLinkedArchivePreview.inventory")(function* (client, input) {
        const limits = clientModeCeiling(client);
        const inventory = yield* readPeerArchiveInventory(environmentId, input, {
          store,
          authorize: (shell) =>
            (linkOriginIsFenced(client) && shell.linkOrigin?.sessionId !== client.sessionId) ||
            exceededDispatchModeLimit(limits, shell) !== undefined
              ? Effect.fail(denied)
              : Effect.void,
        }).pipe(
          Effect.tapError((cause) =>
            "status" in cause
              ? Effect.void
              : Effect.logWarning("Could not read peer archive inventory", cause),
          ),
          Effect.mapError((cause) => ("status" in cause ? cause : offline)),
        );
        if (inventory.threads.length === 0) return inventory;
        const projectIds = [...new Set(inventory.threads.map(({ projectId }) => projectId))];
        const rows = yield* projects.list({ projectIds }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Could not read peer archive projects", cause),
          ),
          Effect.orElseSucceed(() => []),
        );
        const titles = new Map(rows.map(({ projectId, title }) => [projectId, title]));
        return {
          ...inventory,
          threads: inventory.threads.map((thread) => ({
            ...thread,
            projectTitle: titles.get(thread.projectId),
          })),
        };
      }),
    });
  }),
);

export const layer = Layer.effect(
  LastCodeLinkedArchivePreview,
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const links = yield* PeerLinks;
    const store = yield* ProjectionStoreV2;
    const transport = yield* LastCodePeerArchiveTransport;
    const operations = yield* captureLinkedArchiveOperations;
    const load = Effect.fn("LastCodeLinkedArchivePreview.load")(
      function* (
        threadId: ThreadId,
        family: OrchestrationV2ThreadArchiveFamily,
        limits?: ClientModes,
      ) {
        if (!family.threads.some((thread) => thread.id === threadId)) return family;
        const linkedArchiveOperation = yield* operations.status(threadId);
        const preview =
          linkedArchiveOperation === undefined ? family : { ...family, linkedArchiveOperation };
        const deadline = (yield* Clock.currentTimeMillis) + PEER_ARCHIVE_PREVIEW_TIMEOUT_MS;
        const peers = yield* links.listStored ?? Effect.succeed([]);
        if (peers.length === 0 || !(yield* links.enabled)) return preview;
        const beforeDeadline = <A, E>(request: Effect.Effect<A, E>) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              now < deadline
                ? request.pipe(Effect.timeoutOption(deadline - now))
                : Effect.succeed(Option.none<A>()),
            ),
          );
        const input = yield* beforeDeadline(
          Effect.gen(function* () {
            if (linkedArchiveOperation?.operation === "archive") {
              const ownerThreadIds = yield* operations.selectedOwnerThreadIds(threadId);
              if (ownerThreadIds !== undefined)
                return {
                  ownerEnvironmentId: environmentId,
                  ownerThreadIds,
                  keptOwnerThreadIds: [],
                };
            }
            return yield* readPeerArchiveOwnerScope(environmentId, threadId, store);
          }),
        );
        const linkedArchivePreview = yield* Effect.forEach(
          peers,
          ({ environmentId, label }) => {
            const pending = { environmentId, label, ...offline } satisfies LinkedArchivePreview;
            if (Option.isNone(input)) return Effect.succeed(pending);
            return beforeDeadline(transport.inventory(environmentId, input.value, limits)).pipe(
              Effect.match({
                onSuccess: (inventory): LinkedArchivePreview =>
                  Option.match(inventory, {
                    onNone: () => pending,
                    onSome: (value) =>
                      value.archiveChoices === undefined
                        ? { environmentId, label, status: "blocked", reason: "unsupported" }
                        : { environmentId, label, status: "ready", inventory: value },
                  }),
                onFailure: (unavailable): LinkedArchivePreview => ({
                  environmentId,
                  label,
                  ...unavailable,
                }),
              }),
            );
          },
          { concurrency: "unbounded" },
        );
        if (linkedArchiveOperation?.operation !== "archive")
          return { ...preview, linkedArchivePreview };
        const availability = new Map(
          linkedArchivePreview.map((peer) => [peer.environmentId, peer]),
        );
        return {
          ...preview,
          linkedArchivePreview,
          linkedArchiveOperation: {
            ...linkedArchiveOperation,
            machines: linkedArchiveOperation.machines.map((machine) => {
              if (machine.requiresReview !== true) return machine;
              const peer = availability.get(machine.environmentId);
              return peer?.status === "ready"
                ? { ...machine, status: "review" as const, reason: undefined }
                : peer === undefined
                  ? { ...machine, status: "blocked" as const, reason: "unlinked" as const }
                  : { ...machine, status: peer.status, reason: peer.reason };
            }),
          },
        };
      },
      (effect, threadId) =>
        Effect.mapError(effect, (cause) => new OrchestratorProjectionError({ threadId, cause })),
    );
    return LastCodeLinkedArchivePreview.of({ load });
  }),
);

export const localArchivePreview: LastCodeLinkedArchivePreview["Service"]["load"] = (
  _threadId,
  family,
) => Effect.succeed(family);

export const captureLinkedArchivePreview = Effect.serviceOption(LastCodeLinkedArchivePreview).pipe(
  Effect.map(
    Option.match({
      onNone: () => localArchivePreview,
      onSome: (service) => service.load,
    }),
  ),
);

export const withLinkedArchivePreview = Effect.fn("LastCodeLinkedArchivePreview.loadForAgent")(
  function* (
    threadId: ThreadId,
    family: OrchestrationV2ThreadArchiveFamily,
    caller: Pick<Caller, "scope" | "caller">,
    preview: typeof localArchivePreview,
  ) {
    if (fencingLinkOrigin(caller) !== undefined) return family;
    const limits = yield* DispatchModeLimit;
    return yield* preview(threadId, family, limits);
  },
);
