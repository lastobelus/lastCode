// No imports: host scripts read these from checkouts without installed dependencies.
export const DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES = 45;
export const LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES_RANGE = {
  minimum: 1,
  maximum: 1440,
} as const;
