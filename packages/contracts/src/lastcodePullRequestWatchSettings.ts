import * as Schema from "effect/Schema";

export const DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES = 45;
export const LastCodePullRequestWatchQuietMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 1440 }),
);
