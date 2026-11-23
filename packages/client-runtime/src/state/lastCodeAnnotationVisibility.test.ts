import {
  CommandId,
  EnvironmentId,
  MessageId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { getLastCodeAnnotationVisibility } from "./lastCodeAnnotationVisibility.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  createEnvironmentThreadShellAtoms,
  resolveListedAncestorThreadRef,
} from "./threadShell.ts";

type Thread = Parameters<typeof getLastCodeAnnotationVisibility>[0][number];
const hiddenKeys = (threads: readonly Thread[]) =>
  getLastCodeAnnotationVisibility(threads).hiddenThreadKeys;

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
    expect(hiddenKeys([hidden])).toEqual(new Set(["local:hidden"]));
    expect(hiddenKeys([{ ...hidden, [request]: true }])).toEqual(new Set());
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

  expect(hiddenKeys([parent, ...others])).toEqual(
    new Set(["local:parent", "local:first", "linked:second", "local:grandchild"]),
  );
  expect(
    hiddenKeys([parent, first, { ...second, hasPendingUserInput: true }, grandchild, independent]),
  ).toEqual(new Set(["local:parent", "local:first", "local:grandchild"]));
  expect(hiddenKeys([{ ...parent, annotation: null }, ...others])).toEqual(new Set());
});

it("lists a linked delegated child until its pending request is answered", () => {
  const parent = { ...v2ThreadShell, annotation, tags: ["private"] };
  const child = {
    ...v2ThreadShell,
    id: ThreadId.make("delegated"),
    delegatedFrom: { environmentId: local, threadId: parent.id, title: parent.title },
  };
  const waiting = {
    ...child,
    pendingRuntimeRequest: {
      kind: "user_input" as const,
      id: RuntimeRequestId.make("ask"),
      createdAt: v2Now,
    },
  };
  const snapshots = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot>({
      ...v2ShellSnapshot,
      threads: environmentId === local ? [parent] : [waiting],
    }),
  );
  const catalog = Atom.make({
    isReady: true,
    entries: new Map(
      [local, linked].map((environmentId) => [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Fixture",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  const parentHiddenTags = Atom.make<readonly string[] | null>(null);
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: catalog,
    snapshotAtom: snapshots,
    hiddenThreadTagsAtom: (environmentId) =>
      environmentId === local ? parentHiddenTags : Atom.make(null),
  });
  const registry = AtomRegistry.make();
  const visible = () => {
    const hidden = registry.get(shells.annotationHiddenThreadKeysAtom);
    return registry
      .get(shells.navigationThreadShellsAtom)
      .filter(({ environmentId, id }) => !hidden.has(`${environmentId}:${id}`))
      .map(({ id }) => id);
  };
  try {
    expect(visible()).toEqual([child.id]);
    const ref = { environmentId: linked, threadId: child.id };
    expect(
      resolveListedAncestorThreadRef(
        ref,
        registry.get(shells.threadShellsAtom),
        registry.get(shells.annotationPendingChildThreadKeysAtom),
      ),
    ).toEqual(ref);
    registry.set(parentHiddenTags, ["private"]);
    expect(visible()).toEqual([]);
    registry.set(parentHiddenTags, null);
    registry.set(snapshots(linked), { ...v2ShellSnapshot, threads: [child] });
    expect(visible()).toEqual([]);
    registry.set(snapshots(local), {
      ...v2ShellSnapshot,
      threads: [{ ...parent, annotation: null }],
    });
    registry.set(snapshots(linked), { ...v2ShellSnapshot, threads: [waiting] });
    expect(visible()).toEqual([parent.id]);
  } finally {
    registry.dispose();
  }
});
