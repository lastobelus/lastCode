import {
  EnvironmentId,
  HistoricalThreadCreatorOrigin,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { getThreadOwner } from "./threadOwnership.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const creator = ThreadId.make("creator");
const lineage = {
  rootThreadId: ThreadId.make("child"),
  parentThreadId: null,
  relationshipToParent: null,
};
const origin = { kind: "thread_launch", environmentId: remote, threadId: creator } as const;
const ownedLaunch = { lineage, creatorOrigin: { ...origin, owned: true as const } };
const delegatedHere = {
  lineage: { ...lineage, relationshipToParent: "subagent" as const, parentThreadId: creator },
};
const delegatedFrom = { environmentId: remote, threadId: creator, title: "Creator" };

describe("getThreadOwner", () => {
  it("keeps launch provenance readable by the historical origin schema", () => {
    const decoded = Schema.decodeSync(HistoricalThreadCreatorOrigin)(ownedLaunch.creatorOrigin);
    expect(decoded).toEqual(origin);
    expect(getThreadOwner({ lineage, creatorOrigin: decoded }, local)).toBeNull();
  });

  it.each([
    ["an owned launch", ownedLaunch, { environmentId: remote, threadId: creator }],
    ["a local delegated child", delegatedHere, { environmentId: local, threadId: creator }],
    [
      "a remote delegated task",
      { lineage, delegatedFrom },
      { environmentId: remote, threadId: creator },
    ],
    ["historical launch provenance", { lineage, creatorOrigin: origin }, null],
    [
      "an explicitly independent launch",
      { lineage, creatorOrigin: { ...origin, owned: false } },
      null,
    ],
    [
      "legacy creator fields",
      { lineage, creatorThreadId: creator, creatorGrouping: "grouped" },
      null,
    ],
    [
      "a fork",
      { lineage: { ...lineage, relationshipToParent: "fork", parentThreadId: creator } },
      null,
    ],
    [
      "a historical scheduled origin",
      {
        lineage,
        creatorOrigin: {
          kind: "scheduled_task",
          environmentId: local,
          threadId: creator,
          scheduledTaskId: ScheduledTaskId.make("schedule"),
        },
      },
      null,
    ],
  ] as const)("resolves %s", (_label, thread, owner) => {
    expect(getThreadOwner(thread, local)).toEqual(owner);
  });

  it.each([ownedLaunch, delegatedHere, { lineage, delegatedFrom }])(
    "honors a release without removing provenance",
    (thread) => {
      expect(
        getThreadOwner({ ...thread, lineage: { ...thread.lineage, independent: true } }, local),
      ).toBeNull();
    },
  );
});
