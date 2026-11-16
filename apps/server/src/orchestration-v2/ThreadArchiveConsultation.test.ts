import { assert, it } from "@effect/vitest";
import { ThreadId, NodeId, RunId, RunAttemptId, CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  archiveConsultationTargets,
  type ArchiveConsultationSnapshot,
} from "./ThreadArchiveConsultation.ts";

const id = (value: string) => ThreadId.make(value);
const snapshot = (
  name: string,
  parent: string | null = null,
  native = false,
): ArchiveConsultationSnapshot => ({
  thread: {
    id: id(name),
    title: name,
    creationSource: native ? "provider" : "mcp",
    archivedAt: null,
    deletedAt: null,
    lineage: {
      rootThreadId: id("root"),
      parentThreadId: parent === null ? null : id(parent),
      relationshipToParent: parent === null ? null : "subagent",
    },
  },
  providerThreads: [],
  providerTurns: [],
  runs: [],
  runtimeRequests: [],
  subagents: [],
});

it.effect(
  "uses execution ownership, not creator grouping, and identifies the exact blocked attempt",
  () =>
    Effect.gen(function* () {
      const root = snapshot("root");
      const group = snapshot("group");
      const child = snapshot("child", "group");
      const runId = RunId.make("run");
      const attemptId = RunAttemptId.make("attempt");
      const taskId = NodeId.make("task");
      const records = new Map([
        [root.thread.id, root],
        [
          group.thread.id,
          {
            ...group,
            subagents: [
              {
                id: taskId,
                childThreadId: child.thread.id,
                origin: "app_owned" as const,
                status: "running" as const,
              },
            ],
          },
        ],
        [
          child.thread.id,
          {
            ...child,
            runs: [
              { id: runId, ordinal: 1, activeAttemptId: attemptId, status: "running" as const },
            ],
          },
        ],
      ]);
      const targets = yield* archiveConsultationTargets(
        [child.thread.id],
        (threadId) => Effect.succeed(records.get(threadId) ?? null),
        () => Effect.succeed(true),
      );
      assert.deepEqual(targets, [
        {
          ownerThreadId: group.thread.id,
          ownerTitle: "group",
          work: [{ threadId: child.thread.id, taskId, runId, attemptId }],
        },
      ]);
    }),
);

it.effect.each(["request", "background"] as const)(
  "%s keeps an owner busy without awakening native mirrors",
  (work) =>
    Effect.gen(function* () {
      const owner = snapshot("owner");
      const native = snapshot("native", "owner", true);
      const records = new Map([
        [
          owner.thread.id,
          {
            ...owner,
            runtimeRequests: work === "request" ? [{ status: "pending" as const }] : [],
            turnItems:
              work === "background"
                ? [
                    {
                      id: "background-tool",
                      type: "dynamic_tool" as const,
                      status: "running" as const,
                      title: "Pending tool",
                    },
                  ]
                : [],
          },
        ],
        [native.thread.id, native],
      ]);
      const targets = yield* archiveConsultationTargets(
        [native.thread.id],
        (threadId) => Effect.succeed(records.get(threadId) ?? null),
        () => Effect.succeed(true),
      );
      assert.deepEqual(targets, [
        {
          ownerThreadId: owner.thread.id,
          ownerTitle: "owner",
          work: [{ threadId: native.thread.id }],
          unavailableReason: "busy",
        },
      ]);
    }),
);

it.effect("does not consult a released former owner or a disabled recipient", () =>
  Effect.gen(function* () {
    const parent = snapshot("parent");
    const child = snapshot("child", "parent");
    const records = new Map([
      [
        parent.thread.id,
        {
          ...parent,
          subagents: [
            {
              id: NodeId.make("released"),
              childThreadId: child.thread.id,
              origin: "app_owned" as const,
              status: "completed" as const,
              ownershipReleased: true,
            },
          ],
        },
      ],
      [child.thread.id, child],
    ]);
    const targets = yield* archiveConsultationTargets(
      [child.thread.id],
      (threadId) => Effect.succeed(records.get(threadId) ?? null),
      () => Effect.succeed(false),
    );
    assert.equal(targets[0]?.ownerThreadId, child.thread.id);
    assert.equal(targets[0]?.unavailableReason, "unavailable");
  }),
);

it.effect.each(["running", "pending", "failed-archive"] as const)(
  "an idle owner can be asked about a stale %s task even when its child is idle",
  (state) =>
    Effect.gen(function* () {
      const initial = snapshot("owner");
      const owner =
        state === "failed-archive"
          ? {
              ...initial,
              thread: {
                ...initial.thread,
                archivePending: {
                  threadId: initial.thread.id,
                  commandId: CommandId.make("failed-archive"),
                  status: "failed" as const,
                },
              },
            }
          : initial;
      const child = snapshot("child", "owner");
      const taskId = NodeId.make("stale-task");
      const records = new Map([
        [
          owner.thread.id,
          {
            ...owner,
            subagents: [
              {
                id: taskId,
                childThreadId: child.thread.id,
                origin: "app_owned" as const,
                status: state === "pending" ? ("pending" as const) : ("running" as const),
              },
            ],
          },
        ],
        [child.thread.id, child],
      ]);
      const targets = yield* archiveConsultationTargets(
        [owner.thread.id],
        (threadId) => Effect.succeed(records.get(threadId) ?? null),
        () => Effect.succeed(true),
      );
      assert.deepEqual(targets, [
        {
          ownerThreadId: owner.thread.id,
          ownerTitle: "owner",
          work: [{ threadId: child.thread.id, taskId }],
        },
      ]);
    }),
);
