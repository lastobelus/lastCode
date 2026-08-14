export interface ParsedNightlyVersion {
  readonly tag: string;
  readonly parts: ReadonlyArray<number>;
}

export interface LocalUpdateOptions {
  readonly command: "inspect" | "build";
  readonly repoRoot: string;
  readonly home: string;
  readonly currentVersion?: string;
  readonly checkpointTag?: string;
}

export interface ExistingBuild {
  readonly outputDir: string;
  readonly manifestPath: string;
}

export interface ExistingBuildOptions {
  readonly repoRoot: string;
  readonly outputRoot: string;
  readonly checkpointTag: string;
  readonly checkpointCommit: string;
  readonly signingIdentity?: string;
}

export interface LocalSigningConfiguration {
  readonly schemaVersion: 1;
  readonly identityHash: string;
  readonly identityName: string;
  readonly configuredAt?: string;
}

export function resolveDeterministicBuildEnvironment(
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function readLocalSigningConfiguration(home: string): LocalSigningConfiguration | undefined;
export function resolveLocalBuildEnvironment(
  worktreePath: string,
  home: string,
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
export function resolveLatestCheckpointTag(tags: ReadonlyArray<string>): string | undefined;
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

export const RESULT_PREFIX: string;
