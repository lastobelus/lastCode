import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  archiveNeedsConfirmation,
  archiveRepairNeedsConfirmation,
  hasUnreadArchiveResponse,
  hasUnfinishedArchiveWork,
} from "./ThreadArchivePolicy.ts";

const repliedAt = DateTime.makeUnsafe("2026-10-02T00:00:00Z");
const beforeReply = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
const afterReply = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
const controls = {
  thread: { id: ThreadId.make("policy:thread") },
  runs: [],
  runtimeRequests: [],
  providerThreads: [],
  providerTurns: [],
  turnItems: [],
};
const shell = {
  status: "completed" as const,
  latestRunCompletedAt: repliedAt,
  latestVisibleMessage: {
    id: MessageId.make("policy:response"),
    role: "assistant" as const,
    text: "Finished",
    updatedAt: repliedAt,
  },
  lastVisitedAt: afterReply,
};

it("ignores a stale working display flag when authoritative records have no unfinished work", () => {
  const stale = { ...shell, status: "running" as const, activityRunStatus: "running" as const };
  assert.isFalse(archiveNeedsConfirmation(stale, controls, repliedAt));
});

it("warns about finished replies on never-visited or marked-unread conversations", () => {
  assert.isTrue(hasUnreadArchiveResponse({ ...shell, lastVisitedAt: null }, repliedAt));
  assert.isTrue(hasUnreadArchiveResponse({ ...shell, lastVisitedAt: beforeReply }, repliedAt));
  assert.isFalse(hasUnreadArchiveResponse(shell, repliedAt));
});

it("does not use unrelated metadata timestamps or retained failures as unread replies", () => {
  const failure = {
    ...shell,
    status: "failed" as const,
    latestVisibleMessage: null,
    updatedAt: afterReply,
    lastVisitedAt: beforeReply,
    recovery: { status: "needed" },
  };
  assert.isFalse(archiveNeedsConfirmation(failure, controls, null));
});

it("detects imported assistant responses even when no app run exists", () => {
  assert.isTrue(
    hasUnreadArchiveResponse(
      {
        ...shell,
        status: "idle",
        latestRunCompletedAt: null,
        lastVisitedAt: null,
      },
      repliedAt,
    ),
  );
});

it("uses prior delegated consent only for unread repair, never unfinished work", () => {
  assert.isFalse(archiveRepairNeedsConfirmation({ unfinished: false, unread: true }, true));
  assert.isTrue(archiveRepairNeedsConfirmation({ unfinished: false, unread: true }, false));
  assert.isTrue(archiveRepairNeedsConfirmation({ unfinished: true, unread: false }, true));
});

it.each([
  {
    origin: "app_owned",
    childThreadId: ThreadId.make("local-child"),
    status: "pending",
    unfinished: true,
  },
  {
    origin: "app_owned",
    childThreadId: ThreadId.make("local-child"),
    status: "running",
    unfinished: true,
  },
  {
    origin: "app_owned",
    childThreadId: ThreadId.make("local-child"),
    status: "waiting",
    unfinished: true,
  },
  {
    origin: "app_owned",
    childThreadId: ThreadId.make("local-child"),
    status: "completed",
    unfinished: false,
  },
  {
    origin: "app_owned",
    childThreadId: ThreadId.make("local-child"),
    status: "failed",
    unfinished: false,
  },
  {
    origin: "app_owned",
    childThreadId: ThreadId.make("local-child"),
    status: "cancelled",
    unfinished: false,
  },
  { origin: "app_owned", childThreadId: null, status: "running", unfinished: false },
  {
    origin: "provider_native",
    childThreadId: ThreadId.make("native-child"),
    status: "running",
    unfinished: false,
  },
  {
    origin: "app_owned",
    childThreadId: ThreadId.make("released-child"),
    status: "running",
    ownershipReleased: true,
    unfinished: false,
  },
] as const)(
  "detects active local task ownership for $origin $status (local=$childThreadId)",
  ({ unfinished, ...task }) => {
    assert.equal(hasUnfinishedArchiveWork({ ...controls, subagents: [task] }), unfinished);
  },
);
