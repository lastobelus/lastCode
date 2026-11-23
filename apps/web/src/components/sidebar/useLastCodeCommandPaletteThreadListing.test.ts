import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";
import { lastCodePaletteThreadPredicate } from "./useLastCodeCommandPaletteThreadListing";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const owner = makeThreadFixture({
  environmentId: local,
  id: ThreadId.make("owner"),
});
const ownerRef = { environmentId: local, threadId: owner.id };
const launched = makeThreadFixture({
  environmentId: local,
  id: ThreadId.make("launched"),
  creatorOrigin: { kind: "thread_launch", ...ownerRef, owned: true },
});
const delegated = makeThreadFixture({
  environmentId: remote,
  id: ThreadId.make("delegated"),
  delegatedFrom: { ...ownerRef, title: owner.title },
});
const subagent = makeThreadFixture({
  environmentId: local,
  id: ThreadId.make("subagent"),
  lineage: { rootThreadId: owner.id, parentThreadId: owner.id, relationshipToParent: "subagent" },
});
const delegatedUnderParent = new Set([
  threadKey({ environmentId: remote, threadId: delegated.id }),
]);
const threads = [owner, launched, delegated, subagent];
const hidden = new Set([lastcodeSidebarThreadKey(owner)]);

describe("LastCode palette thread listing", () => {
  it("keeps launched children in the jump list and excludes tasks represented by a visible owner", () => {
    const listed = lastCodePaletteThreadPredicate(threads, delegatedUnderParent, new Set(), "");
    expect(threads.filter(listed)).toEqual([owner, launched]);
  });

  it("keeps visible children listed when the owner has a hidden tag", () => {
    const listed = lastCodePaletteThreadPredicate(threads, delegatedUnderParent, hidden, "");
    expect(threads.filter(listed)).toEqual([launched, delegated, subagent]);
    const hiddenChild = new Set([...hidden, lastcodeSidebarThreadKey(delegated)]);
    expect(
      lastCodePaletteThreadPredicate(threads, delegatedUnderParent, hiddenChild, "")(delegated),
    ).toBe(false);
  });

  it("makes an orphaned subagent reachable by typed search without adding it to the default list", () => {
    const loaded = [subagent];
    expect(lastCodePaletteThreadPredicate(loaded, new Set(), new Set(), "")(subagent)).toBe(false);
    expect(lastCodePaletteThreadPredicate(loaded, new Set(), new Set(), "s")(subagent)).toBe(true);
    expect(
      lastCodePaletteThreadPredicate(threads, delegatedUnderParent, new Set(), "s")(subagent),
    ).toBe(false);
  });

  it("includes an annotation-hidden title only during explicit search and always excludes tag-hidden rows", () => {
    const stamp = "2026-01-01T00:00:00.000Z";
    const annotated = makeThreadFixture({
      id: ThreadId.make("annotated"),
      title: "Fix Pairing",
      branch: "mobile-regression",
      annotation: {
        anchorMessageId: MessageId.make("anchor"),
        body: "Wait for checkpoint",
        createdAt: stamp,
        updatedAt: stamp,
        resolvedAt: null,
        hideUntil: { kind: "date", id: CommandId.make("hide"), hiddenAt: stamp, at: stamp },
      },
    });
    const tagHidden = { ...annotated, id: ThreadId.make("tagged-and-annotated") };
    const tagOnly = { ...tagHidden, id: ThreadId.make("tag-only"), annotation: null };
    const siblings = [annotated, tagHidden, tagOnly];
    const tags = new Set([lastcodeSidebarThreadKey(tagHidden), lastcodeSidebarThreadKey(tagOnly)]);
    const find = (query: string) =>
      siblings.filter(lastCodePaletteThreadPredicate(siblings, new Set(), tags, query));

    expect(find("")).toEqual([]);
    expect(find("   ")).toEqual([]);
    expect(find("mobile-regression")).toEqual([]);
    expect(find("  PAIRING  ")).toEqual([annotated]);
  });
});
