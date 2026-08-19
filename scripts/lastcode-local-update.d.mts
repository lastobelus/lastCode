export interface ParsedNightlyVersion {
  readonly tag: string;
  readonly nightlyTag: string;
  readonly parts: ReadonlyArray<number>;
  readonly revision: number;
}

export interface LocalUpdateOptions {
  readonly command: "inspect" | "build";
  readonly repoRoot: string;
  readonly home: string;
  readonly currentVersion?: string;
  readonly checkpointTag?: string;
  readonly releaseNotesFormat?: "grouped-v1";
}

export interface ExistingBuild {
  readonly outputDir: string;
  readonly manifestPath: string;
  readonly dmgPath: string;
  readonly dmgSha256: string;
}

export interface ExistingBuildOptions {
  readonly repoRoot: string;
  readonly outputRoot: string;
  readonly checkpointTag: string;
  readonly checkpointCommit: string;
}

export interface LocalBuildLockOptions {
  readonly pid?: number;
}

export function resolveDeterministicBuildEnvironment(
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function resolveLocalBuildEnvironment(
  worktreePath: string,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function isReusableCheckpointCiStamp(
  stamp: unknown,
  checkpointTag: string,
  checkpointCommit: string,
  upstreamCommit: string,
): boolean;

export function parseNightlyVersion(value: string): ParsedNightlyVersion | undefined;
export function compareNightlyVersions(left: string, right: string): number;
export function resolveLatestInstallableTag(tags: ReadonlyArray<string>): string | undefined;
export function parseOptions(argv: ReadonlyArray<string>): LocalUpdateOptions;
export function resolveExistingBuild(options: ExistingBuildOptions): ExistingBuild | undefined;
export function quarantineIncompleteBuild(
  outputRoot: string,
  checkpointTag: string,
  checkpointCommit: string,
  suffix?: string,
): string | undefined;
export function prepareBuildWorktree(
  repoRoot: string,
  worktreePath: string,
  checkpointTag: string,
  logFd: number | undefined,
): void;
export function acquireBuildLock(updateRoot: string, options?: LocalBuildLockOptions): () => void;

export const RESULT_PREFIX: string;
