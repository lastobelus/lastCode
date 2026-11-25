import * as Schema from "effect/Schema";

import { LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES_RANGE } from "./lastcodePullRequestWatchQuietMinutes.ts";

export { DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES } from "./lastcodePullRequestWatchQuietMinutes.ts";
export const LastCodePullRequestWatchQuietMinutes = Schema.Int.check(
  Schema.isBetween(LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES_RANGE),
);

export const DEFAULT_LASTCODE_ANNOTATION_PR_CHECK_MINUTES = 15;
export const LastCodeAnnotationPrCheckMinutes = Schema.Int.check(
  Schema.isBetween(LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES_RANGE),
);
