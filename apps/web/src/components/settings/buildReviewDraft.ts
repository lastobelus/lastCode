import type { BuildReviewPreview } from "@t3tools/contracts";

export interface BuildReviewDraft {
  readonly preview: BuildReviewPreview | null;
  readonly token: string | null;
  readonly paths: readonly string[];
  readonly notice: string | null;
}

export const EMPTY_BUILD_REVIEW_DRAFT: BuildReviewDraft = {
  preview: null,
  token: null,
  paths: [],
  notice: null,
};

export type BuildReviewDraftAction =
  | { readonly type: "preview"; readonly preview: BuildReviewPreview }
  | { readonly type: "select"; readonly paths: readonly string[]; readonly checked: boolean }
  | { readonly type: "reset"; readonly notice?: string };

export function buildReviewDraftReducer(
  state: BuildReviewDraft,
  action: BuildReviewDraftAction,
): BuildReviewDraft {
  if (action.type === "reset") {
    return { ...EMPTY_BUILD_REVIEW_DRAFT, notice: action.notice ?? null };
  }
  if (action.type === "preview") {
    if (state.token !== null && state.token !== action.preview.token) {
      return {
        ...EMPTY_BUILD_REVIEW_DRAFT,
        notice:
          "The build files or cleanup policy changed. Reload this root and select files again.",
      };
    }
    return {
      ...state,
      preview: action.preview,
      token: action.preview.token,
      // Stored approval is informational; every new review needs explicit selection.
      paths: state.token === null ? [] : state.paths,
    };
  }
  const selectable = new Set(
    state.preview?.files.filter((file) => file.selectable).map((file) => file.path),
  );
  const changed = new Set(action.paths.filter((path) => selectable.has(path)));
  return {
    ...state,
    paths: action.checked
      ? [...new Set([...state.paths, ...changed])]
      : state.paths.filter((path) => !changed.has(path)),
  };
}
