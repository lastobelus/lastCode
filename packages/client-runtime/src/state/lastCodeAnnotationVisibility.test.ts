import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { getLastCodeAnnotationHiddenThreadKeys } from "./lastCodeAnnotationVisibility.ts";

type Thread = Parameters<typeof getLastCodeAnnotationHiddenThreadKeys>[0][number];

const local = EnvironmentId.make("local");
const linked = EnvironmentId.make("linked");
const at = "2026-01-01T00:00:00.000Z";
const annotation: ThreadAnnotation = {
  body: "",
  anchorMessageId: MessageId.make("anchor"),
  createdAt: at,
  updatedAt: at,
  resolvedAt: null,
  hideUntil: { kind: "date", id: CommandId.make("hide"), hiddenAt: at, at },
};

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    environmentId: local,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    delegatedFrom: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "temporarily shows a hidden thread while %s is true",
  (request) => {
    const hidden = thread("hidden", { annotation });
    expect(getLastCodeAnnotationHiddenThreadKeys([hidden])).toEqual(new Set(["local:hidden"]));
    expect(getLastCodeAnnotationHiddenThreadKeys([{ ...hidden, [request]: true }])).toEqual(
      new Set(),
    );
  },
);

it("hides an owned family across environments while keeping a child waiting for an answer visible", () => {
  const parent = thread("parent", { annotation });
  const owner = {
    kind: "thread_launch",
    environmentId: local,
    threadId: parent.id,
    owned: true,
  } as const;
  const first = thread("first", { creatorOrigin: owner });
  const second = thread("second", { environmentId: linked, creatorOrigin: owner });
  const grandchild = thread("grandchild", {
    creatorOrigin: { ...owner, threadId: second.id, environmentId: linked },
  });
  const independent = thread("independent", { creatorOrigin: { ...owner, owned: false } });
  const others = [first, second, grandchild, independent];

  expect(getLastCodeAnnotationHiddenThreadKeys([parent, ...others])).toEqual(
    new Set(["local:parent", "local:first", "linked:second", "local:grandchild"]),
  );
  expect(
    getLastCodeAnnotationHiddenThreadKeys([
      parent,
      first,
      { ...second, hasPendingUserInput: true },
      grandchild,
      independent,
    ]),
  ).toEqual(new Set(["local:parent", "local:first", "local:grandchild"]));
  expect(
    getLastCodeAnnotationHiddenThreadKeys([{ ...parent, annotation: null }, ...others]),
  ).toEqual(new Set());
});
