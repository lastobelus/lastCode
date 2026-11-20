import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { BuildReviewPreview, BuildReviewSelectInput } from "./generatedBuildReview.ts";

const decodeSelection = Schema.decodeUnknownSync(BuildReviewSelectInput);
const decodePreview = Schema.decodeUnknownSync(BuildReviewPreview);
const selection = { targetId: "build-target", previewToken: "snapshot-token", paths: [] };

describe("build file review", () => {
  it("allows empty selection to revoke consent and preserves exact Unicode names", () => {
    expect(decodeSelection(selection).paths).toEqual([]);
    expect(
      decodeSelection({ ...selection, paths: ["assets/hello world.js", "assets/日本語.js"] }).paths,
    ).toEqual(["assets/hello world.js", "assets/日本語.js"]);
  });

  it.each([
    "../source.ts",
    "/tmp/file.js",
    "a/../file.js",
    "a//file.js",
    "a\\b",
    "a\u0000b",
    "a:b",
  ])("rejects unsafe selected path %j", (path) =>
    expect(() => decodeSelection({ ...selection, paths: [path] })).toThrow(),
  );

  it("bounds selected files and requires the current preview fingerprint", () => {
    expect(() => decodeSelection({ ...selection, previewToken: " " })).toThrow();
    expect(() => decodeSelection({ ...selection, paths: Array(1_001).fill("asset.js") })).toThrow();
    expect(
      decodeSelection({ ...selection, paths: Array(1_000).fill("asset.js") }).paths,
    ).toHaveLength(1_000);
  });

  it("can describe an unsafe entry without making it selectable", () => {
    const decoded = decodePreview({
      target: {
        id: "build-target",
        label: "Archived build",
        projectId: "project",
        projectName: "Example",
        worktreePath: "/managed/project/worktree",
        root: "apps/web/dist",
        branch: "completed-work",
        archived: true,
        delayDays: 3,
        eligibleAt: null,
        protectedReason: null,
      },
      token: "snapshot-token",
      files: [
        { path: "name:with-colon", size: 0, bytes: 0, selectable: false, reason: "Unsafe path" },
      ],
      offset: 0,
      totalFiles: 1,
      totalBytes: 0,
      totalSize: 0,
      selectedPaths: [],
    });
    expect(decoded.files[0]?.selectable).toBe(false);
    expect(() => decodeSelection({ ...selection, paths: [decoded.files[0]!.path] })).toThrow();
  });
});
