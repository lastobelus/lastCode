export type DesktopInstallOutcome = {
  readonly path: string;
  readonly record: { readonly id: string; readonly version: string };
  readonly status:
    | "pending"
    | "failed-before-swap"
    | "launch-failed"
    | "backend-failed"
    | "healthy";
  readonly matchesReplacement: boolean;
};

export function beginInstallOutcome(
  updateDirectory: string,
  prepared: {
    readonly targetPath: string;
    readonly staging: string;
    readonly version: string;
    readonly t3Home: string;
  },
): Pick<DesktopInstallOutcome, "path" | "record">;

export function retainedBundlePath(targetPath: string, id: string): string;

export function readDesktopInstallOutcome(
  updateDirectory: string,
  targetPath: string,
  version: string,
  stateDir: string,
): DesktopInstallOutcome | null;

export function recordReplacementBackend(
  outcome: DesktopInstallOutcome,
  ready: boolean,
): Promise<void>;
