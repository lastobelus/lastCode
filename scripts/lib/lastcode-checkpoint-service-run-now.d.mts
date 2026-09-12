export const LASTCODE_CHECKPOINT_SERVICE_LABEL: "codes.lastobelus.lastcode-nightly-checkpoint";

export function checkpointServiceRunNowPaths(homeDirectory: string): {
  readonly plistPath: string;
  readonly requestPath: string;
};

export function isDailyCheckpointLaunchAgent(plist: string): boolean;
export function checkpointServiceRunNowArguments(service: string): string[];

export function requestCheckpointServiceRunNow(
  options: {
    readonly homeDirectory: string;
    readonly uid: number;
    readonly deferDaily?: boolean;
  },
  overrides?: {
    readonly exists?: (path: string) => boolean;
    readonly now?: () => Date;
    readonly readFile?: (path: string) => string;
    readonly runLaunchctl?: (args: string[]) => void;
    readonly writeRequest?: (path: string, value: { readonly requestedAt: string }) => void;
  },
): { readonly status: "not-installed" | "deferred" | "requested" };
