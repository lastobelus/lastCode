import { ProjectId, type BuildReviewPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildReviewDraftReducer, EMPTY_BUILD_REVIEW_DRAFT } from "./buildReviewDraft";

const preview: BuildReviewPreview = {
  target: {
    id: "target",
    label: "Worktree",
    projectId: ProjectId.make("project"),
    projectName: "Project",
    worktreePath: "/workspace/example",
    root: "apps/web/dist",
    branch: "feature",
    archived: false,
    delayDays: 8,
    eligibleAt: null,
    protectedReason: null,
  },
  token: "first",
  offset: 0,
  totalFiles: 3,
  totalSize: 12,
  totalBytes: 4096,
  files: [
    { path: "index.js", size: 6, bytes: 4096, selectable: true, reason: null },
    { path: "notes.txt", size: 6, bytes: 0, selectable: false, reason: "Protected" },
  ],
  selectedPaths: ["index.js"],
};

function startSelection() {
  const loaded = buildReviewDraftReducer(EMPTY_BUILD_REVIEW_DRAFT, { type: "preview", preview });
  return buildReviewDraftReducer(loaded, { type: "select", paths: ["index.js"], checked: true });
}

describe("exact-file build review draft", () => {
  it("never adopts stored approval and only selects safe files explicitly present on the page", () => {
    const loaded = buildReviewDraftReducer(EMPTY_BUILD_REVIEW_DRAFT, { type: "preview", preview });
    expect(loaded.paths).toEqual([]);
    expect(
      buildReviewDraftReducer(loaded, {
        type: "select",
        paths: ["index.js", "notes.txt", "outside-page.js"],
        checked: true,
      }).paths,
    ).toEqual(["index.js"]);
  });

  it("retains explicit selection across pages only for the same fingerprint", () => {
    const selected = startSelection();
    const nextPage = {
      ...preview,
      offset: 200,
      files: [{ path: "chunk.js", size: 1, bytes: 1, selectable: true, reason: null }],
    };
    const paged = buildReviewDraftReducer(selected, { type: "preview", preview: nextPage });
    expect(paged.paths).toEqual(["index.js"]);
    const all = buildReviewDraftReducer(paged, {
      type: "select",
      paths: ["chunk.js"],
      checked: true,
    });
    expect(all.paths).toEqual(["index.js", "chunk.js"]);
    expect(
      buildReviewDraftReducer(all, { type: "select", paths: ["chunk.js"], checked: false }).paths,
    ).toEqual(["index.js"]);
    const changed = buildReviewDraftReducer(all, {
      type: "preview",
      preview: { ...nextPage, token: "changed" },
    });
    expect(changed.preview).toBeNull();
    expect(changed.paths).toEqual([]);
    expect(changed.token).toBeNull();
    expect(changed.notice).toContain("Reload");
    expect(
      buildReviewDraftReducer(changed, {
        type: "preview",
        preview: { ...preview, token: "changed" },
      }).paths,
    ).toEqual([]);
  });

  it("drops stale approval state after failures and requires a new empty review", () => {
    const failed = buildReviewDraftReducer(startSelection(), {
      type: "reset",
      notice: "Reload after failure",
    });
    expect(failed.preview).toBeNull();
    expect(failed.paths).toEqual([]);
    const reloaded = buildReviewDraftReducer(failed, { type: "preview", preview });
    expect(reloaded.paths).toEqual([]);
  });
});
