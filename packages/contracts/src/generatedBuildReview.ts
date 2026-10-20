import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BUILD_REVIEW_PAGE_SIZE = 200;
export const BUILD_REVIEW_FILE_LIMIT = 1_000;

const ReviewPath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      value.length <= 4096 &&
      !value.startsWith("/") &&
      // oxlint-disable-next-line no-control-regex -- Relative file selection must not carry path separators or control escapes.
      !/[\\:\x00-\x1f]/.test(value) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    { expected: "a safe relative build-file path" },
  ),
);

export const BuildReviewTarget = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  projectId: ProjectId,
  projectName: Schema.String,
  worktreePath: Schema.String,
  root: Schema.String,
  branch: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  delayDays: Schema.NullOr(PositiveInt),
  eligibleAt: Schema.NullOr(NonNegativeInt),
  protectedReason: Schema.NullOr(Schema.String),
});
export type BuildReviewTarget = typeof BuildReviewTarget.Type;

export const BuildReviewFile = Schema.Struct({
  path: Schema.String,
  size: NonNegativeInt,
  bytes: NonNegativeInt,
  selectable: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type BuildReviewFile = typeof BuildReviewFile.Type;

export const BuildReviewPreview = Schema.Struct({
  target: BuildReviewTarget,
  token: TrimmedNonEmptyString,
  files: Schema.Array(BuildReviewFile).check(Schema.isMaxLength(BUILD_REVIEW_PAGE_SIZE)),
  offset: NonNegativeInt,
  totalFiles: NonNegativeInt,
  totalBytes: NonNegativeInt,
  totalSize: NonNegativeInt,
  selectedPaths: Schema.Array(ReviewPath).check(Schema.isMaxLength(BUILD_REVIEW_FILE_LIMIT)),
});
export type BuildReviewPreview = typeof BuildReviewPreview.Type;

export const BuildReviewTargetsInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type BuildReviewTargetsInput = typeof BuildReviewTargetsInput.Type;

export const BuildReviewPreviewInput = Schema.Struct({
  targetId: TrimmedNonEmptyString,
  offset: Schema.optionalKey(NonNegativeInt),
});
export type BuildReviewPreviewInput = typeof BuildReviewPreviewInput.Type;

export const BuildReviewSelectInput = Schema.Struct({
  targetId: TrimmedNonEmptyString,
  previewToken: TrimmedNonEmptyString,
  paths: Schema.Array(ReviewPath).check(Schema.isMaxLength(BUILD_REVIEW_FILE_LIMIT)),
});
export type BuildReviewSelectInput = typeof BuildReviewSelectInput.Type;

export const BuildReviewSelectionResult = Schema.Struct({
  selectedCount: NonNegativeInt,
  eligibleAt: Schema.NullOr(NonNegativeInt),
  message: Schema.String,
});
export type BuildReviewSelectionResult = typeof BuildReviewSelectionResult.Type;

export class BuildReviewError extends Schema.TaggedError<BuildReviewError>()("BuildReviewError", {
  message: Schema.String,
}) {}
