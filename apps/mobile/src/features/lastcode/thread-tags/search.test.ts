import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { expect, it } from "vite-plus/test";
import { taggedThreadSearch } from "./search";

it("keeps message-only matches and their jump target while matching titles fuzzily", () => {
  const thread = {
    id: ThreadId.make("thread"),
    environmentId: EnvironmentId.make("local"),
    title: "Layout experiment",
  };
  const messageId = MessageId.make("message");
  const matches = new Map([
    [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      { messageId },
    ],
  ]);
  expect(taggedThreadSearch(thread, "clamp helper", matches)).toEqual({ visible: true, messageId });
  expect(taggedThreadSearch(thread, "lytex", matches)).toEqual({
    visible: true,
    messageId: undefined,
  });
  expect(
    taggedThreadSearch(
      { ...thread, environmentId: EnvironmentId.make("remote") },
      "clamp helper",
      matches,
    ).visible,
  ).toBe(false);
});
