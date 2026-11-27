import { expect, it } from "@effect/vitest";

import { reportUpstreamImportDrift } from "./lastcode-upstream-import-drift.ts";

const sourceCommit = "a".repeat(40);
const pinnedHead = "b".repeat(40);
const movedHead = "c".repeat(40);
const manifestPath = "scripts/lastcode-upstream-imports.json";
const manifest = JSON.stringify([
  {
    upstreamRepo: "example/upstream",
    pullRequest: 12,
    pinnedHead,
    trackingRepo: "example/downstream",
    trackingIssue: 34,
  },
]);

function fixture() {
  const comments: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  let manifestExists = true;
  let failPost = false;
  const input = {
    sourceCommit,
    git: (args: ReadonlyArray<string>) => {
      if (args[0] === "ls-tree") {
        expect(args).toEqual(["ls-tree", "--name-only", sourceCommit, "--", manifestPath]);
        return manifestExists ? manifestPath : "";
      }
      expect(args).toEqual(["show", `${sourceCommit}:${manifestPath}`]);
      return manifest;
    },
    log: (message: string) => logs.push(message),
    warn: (message: string) => warnings.push(message),
  };
  const check = (head: string, state = "open") =>
    reportUpstreamImportDrift({
      ...input,
      api: ([path, ...args]) => {
        if (path === "repos/example/upstream/pulls/12") return JSON.stringify({ head, state });
        if (path === "repos/example/downstream/issues/34/comments?per_page=100") {
          expect(args).toContain("--paginate");
          return comments.map((body) => JSON.stringify(body)).join("\n");
        }
        expect(path).toBe("repos/example/downstream/issues/34/comments");
        expect(args.slice(0, 3)).toEqual(["--method", "POST", "-f"]);
        if (failPost) throw new Error("GitHub unavailable");
        comments.push(args[3]!.slice("body=".length));
        return "";
      },
    });
  return {
    check,
    comments,
    logs,
    warnings,
    omitManifest: () => (manifestExists = false),
    setFailPost: (fail: boolean) => (failPost = fail),
  };
}

it("reports new drift and closure without repeating the same observation", () => {
  const { check, comments, logs, warnings } = fixture();
  check(pinnedHead);
  expect(comments).toHaveLength(0);
  expect(logs[0]).toContain("matches the pinned head");

  check(movedHead);
  check(movedHead);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("https://redirect.github.com/example/upstream/pull/12");
  expect(comments[0]).toContain(`Pinned head: \`${pinnedHead}\``);
  expect(comments[0]).toContain(`Observed head: \`${movedHead}\``);

  check(pinnedHead, "closed");
  check(pinnedHead, "merged");
  expect(comments).toHaveLength(3);
  expect(comments[1]).toContain("is closed.");
  expect(comments[2]).toContain("is merged.");
  expect(warnings).toEqual([]);
});

it("reports a return to the pin so a later recurrence is visible", () => {
  const { check, comments } = fixture();
  check(movedHead);
  check(pinnedHead);
  check(pinnedHead);
  check(movedHead);
  expect(comments).toHaveLength(3);
  expect(comments[1]).toContain("returned to the pinned head");
  expect(comments[0]).toEqual(comments[2]);
});

it("skips older sources without a manifest and retries failed reporting on the next run", () => {
  const { check, comments, logs, warnings, omitManifest, setFailPost } = fixture();
  setFailPost(true);
  check(movedHead);
  expect(warnings[0]).toContain("GitHub unavailable");
  expect(comments).toHaveLength(0);

  setFailPost(false);
  check(movedHead);
  expect(comments).toHaveLength(1);
  omitManifest();
  check(pinnedHead, "closed");
  expect(comments).toHaveLength(1);
  expect(logs).toHaveLength(1);
  expect(warnings).toHaveLength(1);
});
