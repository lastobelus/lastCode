#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Local release orchestration intentionally uses host processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assertCheckpointCiStamp, assertCleanWorktree } from "./lastcode-local-ci.ts";
import {
  buildTagFromCheckpointTag,
  nightlyTagFromCheckpointTag,
  versionFromNightlyTag,
} from "./lastcode-nightly.ts";

interface BuildOptions {
  readonly checkpointTag: string;
  readonly outputRoot: string;
  readonly pushTag: boolean;
  readonly verbose: boolean;
}

interface BuildArtifact {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

interface BuildManifest {
  readonly schemaVersion: 1;
  readonly arch: "arm64";
  readonly artifacts: ReadonlyArray<BuildArtifact>;
  readonly buildTag: string;
  readonly builtAt: string;
  readonly checkpointTag: string;
  readonly lastCodeCommit: string;
  readonly platform: "mac";
  readonly upstreamCommit: string;
  readonly upstreamTag: string;
}

export function parseBuildOptions(argv: ReadonlyArray<string>): BuildOptions {
  let checkpointTag: string | undefined;
  let outputRoot = "release-lastcode";
  let pushTag = false;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--checkpoint" || arg === "--output-root") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--checkpoint") checkpointTag = value;
      else outputRoot = value;
      index += 1;
    } else if (arg === "--push-tag") pushTag = true;
    else if (arg === "--verbose") verbose = true;
    else throw new Error(`Unknown argument '${arg}'.`);
  }

  if (!checkpointTag) {
    throw new Error(
      "A checkpoint is required. Pass --checkpoint lastcode/checkpoint/vX.Y.Z-nightly.YYYYMMDD.N.",
    );
  }
  if (!nightlyTagFromCheckpointTag(checkpointTag)) {
    throw new Error(`Invalid LastCode checkpoint tag '${checkpointTag}'.`);
  }
  return { checkpointTag, outputRoot, pushTag, verbose };
}

export function resolveNextBuildNumber(
  checkpointTag: string,
  existingBuildTags: ReadonlyArray<string>,
): number {
  const prefix = checkpointTag.replace("lastcode/checkpoint/", "lastcode/build/") + ".";
  const used = existingBuildTags.flatMap((tag) => {
    if (!tag.startsWith(prefix)) return [];
    const value = Number(tag.slice(prefix.length));
    return Number.isSafeInteger(value) && value > 0 ? [value] : [];
  });
  return Math.max(0, ...used) + 1;
}

export function resolveBuildEnvironment(
  cargoPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    PATH: `${NodePath.dirname(cargoPath)}${NodePath.delimiter}${environment.PATH ?? ""}`,
    T3CODE_DESKTOP_UPDATE_REPOSITORY:
      environment.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode",
  };
}

function run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly capture?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
        options.capture ? result.stderr.trim() : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return options.capture ? result.stdout.trim() : "";
}

function git(repoRoot: string, args: ReadonlyArray<string>): string {
  return run(repoRoot, "git", args, { capture: true });
}

function hashFile(path: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

function collectArtifacts(outputDir: string): ReadonlyArray<BuildArtifact> {
  return NodeFS.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "build-manifest.json")
    .map((entry) => {
      const path = NodePath.join(outputDir, entry.name);
      return {
        bytes: NodeFS.statSync(path).size,
        path: entry.name,
        sha256: hashFile(path),
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

function main(argv: ReadonlyArray<string>): void {
  const options = parseBuildOptions(argv);
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  assertCleanWorktree(repoRoot);

  const nightlyTag = nightlyTagFromCheckpointTag(options.checkpointTag)!;
  const commit = git(repoRoot, ["rev-parse", "HEAD"]);
  const checkpointCommit = git(repoRoot, ["rev-parse", `${options.checkpointTag}^{commit}`]);
  if (commit !== checkpointCommit) {
    throw new Error(
      `HEAD ${commit} does not match requested checkpoint ${options.checkpointTag} at ${checkpointCommit}.`,
    );
  }
  const upstreamCommit = git(repoRoot, ["rev-parse", `${nightlyTag}^{commit}`]);
  const commonGitDir = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  assertCheckpointCiStamp(commonGitDir, checkpointCommit, options.checkpointTag, upstreamCommit);

  const shortCommit = git(repoRoot, ["rev-parse", "--short=10", commit]);
  const outputDir = NodePath.resolve(repoRoot, options.outputRoot, nightlyTag, shortCommit);
  if (NodeFS.existsSync(outputDir)) {
    throw new Error(
      `Build output already exists at ${outputDir}; artifacts are never overwritten.`,
    );
  }
  NodeFS.mkdirSync(outputDir, { recursive: true });

  const cargoPath = run(repoRoot, "rustup", ["which", "cargo", "--toolchain", "stable"], {
    capture: true,
  });
  const env = resolveBuildEnvironment(cargoPath);
  console.log(`[lastcode:build] Building ${options.checkpointTag} at ${commit}.`);
  run(
    repoRoot,
    "node",
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      "arm64",
      "--build-version",
      versionFromNightlyTag(nightlyTag),
      "--output-dir",
      outputDir,
      ...(options.verbose ? ["--verbose"] : []),
    ],
    { env },
  );

  const existingBuildTags = git(repoRoot, ["tag", "--list", "lastcode/build/*"])
    .split(/\r?\n/)
    .filter(Boolean);
  const buildNumber = resolveNextBuildNumber(options.checkpointTag, existingBuildTags);
  const buildTag = buildTagFromCheckpointTag(options.checkpointTag, buildNumber);
  const manifest: BuildManifest = {
    schemaVersion: 1,
    arch: "arm64",
    artifacts: collectArtifacts(outputDir),
    buildTag,
    builtAt: new Date().toISOString(),
    checkpointTag: options.checkpointTag,
    lastCodeCommit: commit,
    platform: "mac",
    upstreamCommit,
    upstreamTag: nightlyTag,
  };
  NodeFS.writeFileSync(
    NodePath.join(outputDir, "build-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(outputDir, "SHA256SUMS"),
    `${manifest.artifacts.map(({ path, sha256 }) => `${sha256}  ${path}`).join("\n")}\n`,
  );
  git(repoRoot, [
    "tag",
    "--annotate",
    buildTag,
    commit,
    "--message",
    `LastCode local build ${buildTag}\n\nCheckpoint: ${options.checkpointTag}\nManifest: ${NodePath.relative(repoRoot, NodePath.join(outputDir, "build-manifest.json"))}`,
  ]);
  if (options.pushTag) run(repoRoot, "git", ["push", "origin", buildTag]);
  console.log(`[lastcode:build] Created ${buildTag}.`);
  console.log(`[lastcode:build] Artifacts: ${outputDir}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[lastcode:build] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
