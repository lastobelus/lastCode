import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { expect, it } from "vite-plus/test";
import { makeThreadShellFixture } from "../../../test-fixtures";
import { taggedThreadSearch } from "./search";

it("keeps field and message-only matches with the appropriate jump target", () => {
  const thread = makeThreadShellFixture({
    id: ThreadId.make("thread"),
    environmentId: EnvironmentId.make("local"),
    title: "Layout experiment",
    branch: "fix/sidebar-spacing",
  });
  const searchableThread = {
    ...thread,
    searchPullRequests: [{ number: 123, title: "Tighten header margins", references: [] }],
  };
  const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
  const messageId = MessageId.make("message");
  const matches = new Map([
    [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      { messageId },
    ],
  ]);
  expect(taggedThreadSearch([thread], "clamp helper", matches, nowMs)).toEqual([
    { thread, messageId },
  ]);
  expect(taggedThreadSearch([thread], "lay exp", matches, nowMs)).toEqual([
    { thread, messageId: undefined },
  ]);
  for (const query of ["sidebar-spacing", "#123", "header margins", "layuot"]) {
    expect(taggedThreadSearch([searchableThread], query, new Map(), nowMs)).toEqual([
      { thread: searchableThread, messageId: undefined },
    ]);
  }
  expect(
    taggedThreadSearch(
      [{ ...thread, environmentId: EnvironmentId.make("remote") }],
      "clamp helper",
      matches,
      nowMs,
    ),
  ).toEqual([]);
  const exactMatch = { ...thread, id: ThreadId.make("exact"), title: "Layuot" };
  expect(taggedThreadSearch([thread, exactMatch], "layuot", new Map(), nowMs)).toEqual([
    { thread: exactMatch, messageId: undefined },
  ]);
});
