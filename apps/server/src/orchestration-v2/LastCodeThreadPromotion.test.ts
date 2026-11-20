import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
  type RemoteDelegationAssociation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { hasReleasedTaskResult, makeLastCodeThreadPromotion } from "./LastCodeThreadPromotion.ts";

type Task = Pick<OrchestrationV2Subagent, "status" | "result" | "completionDelivery">;

describe("promotion eligibility for delegated results", () => {
  it.each([
    ["running", null, undefined, false],
    ["completed", "Done", undefined, false],
    ["completed", "Done", "pending", false],
    ["completed", "Done", "claimed", false],
    ["completed", "Done", "acknowledged", true],
    ["completed", "Done", "delivered", true],
    ["completed", "Done", "disposed", true],
    ["cancelled", null, "disposed", false],
    ["cancelled", "Cancelled", "disposed", true],
  ] satisfies ReadonlyArray<
    readonly [
      Task["status"],
      Task["result"],
      NonNullable<Task["completionDelivery"]>["state"] | undefined,
      boolean,
    ]
  >)("handles a %s task with result %s and delivery %s", (status, result, state, eligible) => {
    expect(
      hasReleasedTaskResult({
        status,
        result,
        ...(state === undefined ? {} : { completionDelivery: { state, observedByRunId: null } }),
      }),
    ).toBe(eligible);
  });
});

const here = EnvironmentId.make("local");
const elsewhere = EnvironmentId.make("peer");
const ownerId = ThreadId.make("owner");
const childId = ThreadId.make("child");

const child = idleThreadProjection(liveThreadShell(childId)).thread;
const owner = liveThreadShell(ownerId);

const plannerFor = (thread: typeof child, localOwner: typeof owner | null = null) =>
  makeLastCodeThreadPromotion(
    {
      getThread: () => Effect.succeed(thread),
      getThreadShell: () => Effect.succeed(localOwner),
      getThreadRecords: () =>
        Effect.succeed({ ...idleThreadProjection(liveThreadShell(childId)), thread }),
    },
    Effect.succeed(here),
  );

it.effect(
  "releases a launched child and restores default placement only to an available local owner",
  () =>
    Effect.gen(function* () {
      const launched = {
        ...child,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        creatorThreadId: ownerId,
        creatorGrouping: "grouped" as const,
        groupedUnderThreadId: ownerId,
        creatorOrigin: {
          kind: "thread_launch" as const,
          environmentId: here,
          threadId: ownerId,
          owned: true as const,
        },
      };
      const promotion = yield* plannerFor(launched).plan(childId, "promote");
      expect(promotion.payload).toMatchObject({
        creatorOrigin: launched.creatorOrigin,
        lineage: { independent: true },
        groupedUnderThreadId: null,
      });
      expect(promotion.previousGroupedUnderThreadId).toBe(ownerId);
      const archivedOwner = yield* plannerFor(promotion.payload, {
        ...owner,
        archivedAt: DateTime.makeUnsafe(0),
      }).read(childId);
      expect(archivedOwner).toMatchObject({
        availability: { action: "return_to_owner", refusal: "owner_unavailable" },
      });
      const returned = yield* plannerFor(promotion.payload, owner).plan(childId, "return_to_owner");
      expect(returned.payload.creatorOrigin).toEqual(launched.creatorOrigin);
      expect(returned.payload.lineage).toEqual(launched.lineage);
      expect(returned.payload.groupedUnderThreadId).toBe(ownerId);
    }),
);

it.effect.each([
  { ...owner, projectId: ProjectId.make("another-project") },
  { ...owner, lineage: { ...owner.lineage, sideChat: true } },
])(
  "keeps a returned child at the project root when its owner cannot be its placement parent",
  (localOwner) =>
    Effect.gen(function* () {
      const promoted = {
        ...child,
        createdBy: "agent" as const,
        creatorThreadId: ownerId,
        creatorGrouping: "grouped" as const,
        groupedUnderThreadId: null,
        lineage: { ...child.lineage, independent: true },
        creatorOrigin: {
          kind: "thread_launch" as const,
          threadId: ownerId,
          environmentId: here,
          owned: true,
        },
      };
      const result = yield* plannerFor(promoted, localOwner).plan(childId, "return_to_owner");
      expect(result.payload.lineage).not.toHaveProperty("independent");
      expect(result.payload.groupedUnderThreadId).toBeNull();
    }),
);

it.effect.each([
  ["prepared", false, "in_flight"],
  ["active", false, "in_flight"],
  ["settled", false, "in_flight"],
  ["settled", true, null],
  ["disposed", false, null],
] as const)(
  "checks destination evidence for a %s remote association before allowing return without a local owner",
  ([stage, hasFinalRun, refusal]) =>
    Effect.gen(function* () {
      const remote = {
        ...child,
        delegatedFrom: { environmentId: elsewhere, threadId: ownerId, title: "Owner" },
        remoteDelegations: [
          {
            parentEnvironmentId: elsewhere,
            parentThreadId: ownerId,
            sourceTaskId: NodeId.make("task"),
            delegationId: "delegation",
            linkSessionId: "session",
            stage,
            ...(hasFinalRun
              ? { finalRun: { runId: RunId.make("run"), status: "completed" as const } }
              : {}),
          } satisfies RemoteDelegationAssociation,
        ],
      };
      const planner = plannerFor(remote);
      expect((yield* planner.read(childId)).availability).toEqual({
        action: "promote",
        ownerHere: false,
        refusal,
      });
      if (refusal !== null) return;
      const promotion = yield* planner.plan(childId, "promote");
      expect(promotion.payload.remoteDelegations).toEqual(remote.remoteDelegations);
      const returnPlanner = plannerFor(promotion.payload);
      expect((yield* returnPlanner.read(childId)).availability).toEqual({
        action: "return_to_owner",
        ownerHere: false,
        refusal: null,
      });
      const returned = yield* returnPlanner.plan(childId, "return_to_owner");
      expect(returned.payload.delegatedFrom).toEqual(remote.delegatedFrom);
      expect(returned.payload.lineage).toEqual(remote.lineage);
    }),
);
