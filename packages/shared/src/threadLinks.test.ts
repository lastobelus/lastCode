import { describe, expect, it } from "vite-plus/test";

import {
  formatThreadLink,
  parseThreadLinkHref,
  parseThreadLinkReference,
  relabelThreadLinks,
} from "./threadLinks.ts";

describe("thread links", () => {
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
    });
    expect(parseThreadLinkHref(href)).toBe("thread:delegated:mcp%3A1");
    expect(formatThreadLink("thread:delegated:mcp%3A1", "Task", "remote")).toBe(`[Task](${href})`);
    expect(parseThreadLinkReference("t3-thread://v1/local-thread")).toEqual({
      threadId: "local-thread",
    });
    expect(parseThreadLinkReference("t3-thread://v1//thread")).toBeNull();
    expect(parseThreadLinkReference("t3-thread://v1/remote/")).toBeNull();
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
        "[Remote title](t3-thread://v1/remote/shared)",
        "[Decoded remote](t3-thread://v1/remote/thread:1)",
        "[Literal remote](t3-thread://v1/remote/literal%3A1)",
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
    // A thread with an empty title still exists, so its link is not redirected.
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

  it("relabels links with the current title and leaves unknown threads alone", () => {
    const titles = new Map([["renamed", "Fix [the] build\nnow"]]);
    expect(
      relabelThreadLinks(
        "See [Old name](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted).",
        (threadId) => titles.get(threadId),
      ),
    ).toBe("See [Fix the build now](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted).");
  });
});
