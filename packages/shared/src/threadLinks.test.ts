import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  formatThreadLink,
  parseThreadLinkHref,
  parseThreadLinkReference,
  resolveThreadLinkReference,
  relabelThreadLinks,
  resolveThreadLinkRef,
} from "./threadLinks.ts";

const ref = (environmentId: string, threadId = "chat-1") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

describe("thread link destinations", () => {
  it("prefers the local literal id, then the local decoded id, over remote matches", () => {
    const source = ref("local", "provider%3A1");
    const decoded = ref("local", "provider:1");
    const remote = ref("remote", "provider%3A1");
    expect(resolveThreadLinkRef(source, [remote, decoded, source])).toEqual(source);
    expect(resolveThreadLinkRef(source, [remote, decoded])).toEqual(decoded);
  });

  it("opens the unique matching chat in another environment", () => {
    const destination = ref("remote");
    expect(resolveThreadLinkRef(ref("local"), [ref("local", "other-chat"), destination])).toEqual(
      destination,
    );
  });

  it("leaves ambiguous or missing destinations unresolved", () => {
    const source = ref("local", "provider%3A1");
    const literal = ref("remote", "provider%3A1");
    const decoded = ref("remote", "provider:1");
    expect(
      resolveThreadLinkRef(source, [literal, ref("other-remote", literal.threadId), decoded]),
    ).toBeNull();
    expect(
      resolveThreadLinkRef(source, [decoded, ref("other-remote", decoded.threadId)]),
    ).toBeNull();
    expect(resolveThreadLinkRef(source, [ref("remote", "other-chat")])).toBeNull();
  });
});

describe("thread links", () => {
  it("round trips scoped IDs containing slashes, spaces, parentheses, and literal percent escapes", () => {
    const link = formatThreadLink("team/thread%2F(one)", "Title", "team/west office");
    expect(link).toBe("[Title](t3-thread://v2/team%2Fwest%20office/team%2Fthread%252F%28one%29)");
    const href = link.slice(link.indexOf("](") + 2, -1);
    const reference = parseThreadLinkReference(href);
    expect(reference).toEqual({
      environmentId: "team/west office",
      threadId: "team/thread%2F(one)",
      version: 2,
    });
    expect(relabelThreadLinks(link, () => "Renamed")).toBe(link.replace("Title", "Renamed"));
  });

  it("rejects invalid scoped V2 paths and percent escapes", () => {
    for (const href of [
      "t3-thread://v2/env/thread/extra",
      "t3-thread://v2/env",
      "t3-thread://v2//thread",
      "t3-thread://v2/env/",
      "t3-thread://v2/%ZZ/thread",
      "t3-thread://v2/env/%",
      "t3-thread://v2/env/%20",
    ]) {
      expect(parseThreadLinkReference(href)).toBeNull();
    }
  });

  it("does not apply legacy percent-decoding fallback to V2 IDs", () => {
    const reference = parseThreadLinkReference("t3-thread://v2/remote/literal%252Fid")!;
    const lookup = (id: string) => (id === "literal/id" ? "Different thread" : undefined);
    expect(resolveThreadLinkReference(reference, lookup)).toMatchObject({
      threadId: "literal%2Fid",
      environmentId: "remote",
      value: undefined,
    });
    expect(relabelThreadLinks("[Kept](t3-thread://v2/remote/literal%252Fid)", lookup)).toBe(
      "[Kept](t3-thread://v2/remote/literal%252Fid)",
    );
  });

  it("resolves legacy local slash paths, preferring an existing scoped V1 destination", () => {
    const reference = parseThreadLinkReference("t3-thread://v1/team/thread")!;
    const local = (id: string, env?: string) =>
      env === undefined && id === "team/thread" ? "Local" : undefined;
    expect(resolveThreadLinkReference(reference, local)).toMatchObject({
      threadId: "team/thread",
      environmentId: undefined,
      value: "Local",
    });
    const both = (id: string, env?: string) =>
      env === "team" && id === "thread" ? "" : local(id, env);
    expect(resolveThreadLinkReference(reference, both)).toMatchObject({
      threadId: "thread",
      environmentId: "team",
      value: "",
    });
    expect(relabelThreadLinks("[Old](t3-thread://v1/team/thread)", local)).toBe(
      "[Local](t3-thread://v1/team/thread)",
    );
    const encodedLegacy = parseThreadLinkReference("t3-thread://v1/team/thread%3Aone")!;
    expect(
      resolveThreadLinkReference(encodedLegacy, (id, env) =>
        env === undefined && id === "team/thread:one" ? "Decoded local" : undefined,
      ),
    ).toMatchObject({
      threadId: "team/thread:one",
      environmentId: undefined,
      value: "Decoded local",
    });
  });

  it("keeps an uncached archived legacy slash ID local without changing its label", () => {
    const markdown = "[Archived task](t3-thread://v1/team/thread%3Aone)";
    const reference = parseThreadLinkReference("t3-thread://v1/team/thread%3Aone")!;
    expect(resolveThreadLinkReference(reference, () => undefined)).toEqual({
      threadId: "team/thread%3Aone",
      environmentId: undefined,
      value: undefined,
    });
    expect(relabelThreadLinks(markdown, () => undefined)).toBe(markdown);
  });

  it("keeps an uncached V2 archived thread in its explicit remote environment", () => {
    const markdown = "[Archived remote](t3-thread://v2/team%2Fwest/thread%2Ftask)";
    const reference = parseThreadLinkReference("t3-thread://v2/team%2Fwest/thread%2Ftask")!;
    expect(resolveThreadLinkReference(reference, () => undefined)).toEqual({
      threadId: "thread/task",
      environmentId: "team/west",
      value: undefined,
    });
    expect(relabelThreadLinks(markdown, () => undefined)).toBe(markdown);
  });

  it("leaves scoped V2 links in code spans and fences untouched", () => {
    const markdown =
      "[Old](t3-thread://v2/env/id) `[Old](t3-thread://v2/env/id)`\n```md\n[Old](t3-thread://v2/env/id)\n```";
    expect(relabelThreadLinks(markdown, () => "New")).toBe(markdown.replace("[Old]", "[New]"));
  });
  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
  });

  it("round trips an environment-scoped reference without decoding its thread id", () => {
    const href = "t3-thread://v1/remote/thread:delegated:mcp%3A1";
    expect(parseThreadLinkReference(href)).toEqual({
      environmentId: "remote",
      threadId: "thread:delegated:mcp%3A1",
      version: 1,
      legacyThreadId: "remote/thread:delegated:mcp%3A1",
    });
    expect(parseThreadLinkHref(href)).toBe("thread:delegated:mcp%3A1");
    expect(formatThreadLink("thread:delegated:mcp%3A1", "Task", "remote")).toBe(
      "[Task](t3-thread://v2/remote/thread%3Adelegated%3Amcp%253A1)",
    );
    expect(parseThreadLinkReference("t3-thread://v1/local-thread")).toEqual({
      threadId: "local-thread",
      version: 1,
    });
    expect(parseThreadLinkReference("t3-thread://v1//thread")).toEqual({
      threadId: "/thread",
      version: 1,
    });
    expect(parseThreadLinkReference("t3-thread://v1/remote/")).toEqual({
      threadId: "remote/",
      version: 1,
    });
  });

  it("resolves titles and percent-decoded fallback only in the link's owning environment", () => {
    const titles = new Map([
      ["local:shared", "Local title"],
      ["remote:shared", "Remote title"],
      ["remote:thread:1", "Decoded remote"],
      ["remote:literal%3A1", "Literal remote"],
      ["local:missing", "Unrelated local thread"],
    ]);
    expect(
      relabelThreadLinks(
        [
          "[old](t3-thread://v1/shared)",
          "[old](t3-thread://v1/remote/shared)",
          "[old](t3-thread://v1/remote/thread%3A1)",
          "[old](t3-thread://v1/remote/literal%3A1)",
          "[Kept](t3-thread://v1/remote/missing)",
        ].join(" "),
        (threadId, environmentId) => titles.get(`${environmentId ?? "local"}:${threadId}`),
      ),
    ).toBe(
      [
        "[Local title](t3-thread://v1/shared)",
        "[Remote title](t3-thread://v2/remote/shared)",
        "[Decoded remote](t3-thread://v2/remote/thread%3A1)",
        "[Literal remote](t3-thread://v2/remote/literal%253A1)",
        "[Kept](t3-thread://v1/remote/missing)",
      ].join(" "),
    );
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const titles = new Map([
      ["thread:project:1", "Decoded"],
      ["provider%3A1", "Literal escape"],
    ]);
    expect(
      relabelThreadLinks(
        "[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "[Decoded](t3-thread://v1/thread:project:1) [Literal escape](t3-thread://v1/provider%3A1)",
    );
    const untitled = new Map([
      ["a%3A1", ""],
      ["a:1", "Other"],
    ]);
    expect(
      relabelThreadLinks("[Kept](t3-thread://v1/a%3A1)", (threadId) => untitled.get(threadId)),
    ).toBe("[Kept](t3-thread://v1/a%3A1)");
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
      "```md",
      "[old](t3-thread://v1/t1)",
      "```",
      "After [old](t3-thread://v1/t1)",
    ].join("\n");
    expect(relabelThreadLinks(markdown, () => "New")).toBe(
      [
        "Live [New](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
        "```md",
        "[old](t3-thread://v1/t1)",
        "```",
        "After [New](t3-thread://v1/t1)",
      ].join("\n"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe("[Fix ci build](t3-thread://v1/t1)");
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](t3-thread://v1/t1)");
  });
});
