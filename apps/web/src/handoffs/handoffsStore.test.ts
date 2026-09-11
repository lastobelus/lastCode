import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  handoffTargetKey,
  handoffTitle,
  handoffBrowserTarget,
  hasFileHandoff,
  purgeThreadHandoffs,
  readThreadHandoffs,
  recordHandoff,
  recordKnownFileHandoff,
  rememberHandoffBrowser,
  resolveHandoffFilePath,
  sanitizeHandoffsState,
  updateHandoffBrowserTitle,
  upsertHandoff,
  useHandoffsStore,
} from "./handoffsStore";

const ref = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const file = { kind: "file" as const, path: "/workspace/mockup.html" };
beforeEach(() => useHandoffsStore.setState({ byThreadKey: {} }));

describe("handoff identity and ordering", () => {
  it("resolves paths on the host platform and ignores lines for identity", () => {
    expect(resolveHandoffFilePath("./a/../mockup.html", "/workspace")).toBe(file.path);
    expect(resolveHandoffFilePath("a/../mockup.html", "C:\\workspace")).toBe(
      "C:/workspace/mockup.html",
    );
    expect(resolveHandoffFilePath("../mockup.html", "\\\\server\\share\\folder")).toBe(
      "//server/share/mockup.html",
    );
    expect(resolveHandoffFilePath("relative.html")).toBeNull();
    expect(handoffTargetKey({ ...file, line: 9 })).toBe(handoffTargetKey(file));
  });
  it("preserves meaningful URL distinctions and PR destination kind", () => {
    const key = (url: string) => handoffTargetKey({ kind: "url", url });
    expect(
      new Set([
        key("http://localhost:8000/a?q=1#x"),
        key("http://localhost:8001/a?q=1#x"),
        key("http://localhost:8000/a?q=2#x"),
        key("http://localhost:8000/a?q=1#y"),
      ]).size,
    ).toBe(4);
    expect(
      handoffTargetKey({ kind: "pull-request", projectId: "p", repository: "org/repo", number: 1 }),
    ).not.toBe(key("https://github.com/org/repo/pull/1"));
  });
  it("moves duplicates first with a stable tie breaker and preserves authored labels", () => {
    let entries = upsertHandoff([], file, { label: "First", at: 10 });
    entries = upsertHandoff(entries, { kind: "url", url: "https://example.com/" }, { at: 10 });
    entries = upsertHandoff(entries, { ...file, line: 7 }, { at: 9, title: "Page title" });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.sequence).toBe(3);
    expect(handoffTitle(entries[0]!)).toBe("First");
    entries = upsertHandoff(entries, file, { label: "Replacement" });
    expect(handoffTitle(entries[0]!)).toBe("Replacement");
  });
});

describe("handoff persistence and provenance", () => {
  it("round trips valid records and discards malformed persisted entries", () => {
    const entries = upsertHandoff([], file, { label: "Mockup", at: 123 });
    const saved = JSON.parse(
      JSON.stringify({
        byThreadKey: {
          scope: [
            ...entries,
            { target: { kind: "file", path: "relative" }, sequence: 2, lastOpenedAt: 1 },
            null,
          ],
        },
      }),
    );
    expect(sanitizeHandoffsState(saved)).toEqual({ scope: entries });
    expect(sanitizeHandoffsState({ byThreadKey: { bad: null } })).toEqual({});
    expect(sanitizeHandoffsState(null)).toEqual({});
    const unc = upsertHandoff([], { kind: "file", path: "//server/share/report.html" });
    expect(sanitizeHandoffsState(JSON.parse(JSON.stringify({ byThreadKey: { unc } })))).toEqual({
      unc,
    });
  });
  it("isolates threads and environments", () => {
    recordHandoff(ref, file);
    expect(readThreadHandoffs(ref)).toHaveLength(1);
    expect(readThreadHandoffs({ ...ref, threadId: ThreadId.make("thread-b") })).toEqual([]);
    expect(
      readThreadHandoffs({ ...ref, environmentId: EnvironmentId.make("environment-b") }),
    ).toEqual([]);
  });
  it("purges persisted handoffs and browser provenance only for the deleted thread", () => {
    const siblingThread = { ...ref, threadId: ThreadId.make("thread-a:child") };
    const siblingEnvironment = {
      ...ref,
      environmentId: EnvironmentId.make("environment-b"),
    };
    const refs = [ref, siblingThread, siblingEnvironment];

    for (const currentRef of refs) {
      recordHandoff(currentRef, file);
      rememberHandoffBrowser(currentRef, "tab", file, "https://example.com/asset");
    }

    purgeThreadHandoffs(ref);

    expect(readThreadHandoffs(ref)).toEqual([]);
    expect(handoffBrowserTarget(ref, "tab")).toBeUndefined();
    for (const currentRef of [siblingThread, siblingEnvironment]) {
      expect(readThreadHandoffs(currentRef)).toHaveLength(1);
      expect(handoffBrowserTarget(currentRef, "tab")).toEqual({
        target: file,
        url: "https://example.com/asset",
      });
    }
  });
  it("does not create entries for an unrecorded globe or provenance alone", () => {
    rememberHandoffBrowser(ref, "tab", file, "https://example.com/asset");
    recordKnownFileHandoff(ref, file.path);
    expect(readThreadHandoffs(ref)).toEqual([]);
    recordHandoff(ref, file, { label: "Mockup" });
    recordKnownFileHandoff(ref, file.path);
    expect(readThreadHandoffs(ref)).toHaveLength(1);
    expect(hasFileHandoff(ref, file.path)).toBe(true);
  });
  it("enriches only the matching browser title without changing label or recency", () => {
    recordHandoff(ref, file, { label: "Authored" });
    rememberHandoffBrowser(ref, "tab", file, "https://example.com/asset");
    const initial = readThreadHandoffs(ref)[0]!;
    updateHandoffBrowserTitle(ref, "tab", "Wrong page", "https://elsewhere.example/");
    expect(readThreadHandoffs(ref)[0]).toEqual(initial);
    updateHandoffBrowserTitle(ref, "tab", "Page", "https://example.com/asset");
    expect(readThreadHandoffs(ref)[0]).toEqual({ ...initial, title: "Page" });
    expect(handoffTitle(readThreadHandoffs(ref)[0]!)).toBe("Authored");
  });
});
