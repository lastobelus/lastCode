#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- GitHub release automation.
import * as NodeChildProcess from "node:child_process";

import {
  createBuildIntelDependencies,
  runSelectedIntelBuild,
  selectIntelBuild,
} from "./lastcode-build-intel-package.ts";

const fullCommitPattern = /^[0-9a-f]{40}$/u;
const installableTagPattern =
  /^lastcode\/(checkpoint|revision)\/v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)(?:\.(\d+))?$/u;

function parseInstallableTag(tag: string): ReadonlyArray<number> | null {
  const match = installableTagPattern.exec(tag);
  if (!match) return null;
  const [, kind, major, minor, patch, date, runNumber, rawRevision] = match;
  const revision = rawRevision === undefined ? 0 : Number(rawRevision);
  if (
    (kind === "checkpoint" && rawRevision !== undefined) ||
    (kind === "revision" && revision < 1)
  ) {
    return null;
  }
  const order = [major, minor, patch, date, runNumber, revision].map(Number);
  return order.every(Number.isSafeInteger) ? order : null;
}

function compareInstallables(left: ReadonlyArray<number>, right: ReadonlyArray<number>): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function fail(message: string): never {
  throw new Error(message);
}

function runCommand(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(result.stderr.trim() || `${command} ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

export function latestInstallableFromRemoteRefs(output: string): {
  readonly tag: string;
  readonly commit: string;
} {
  const refs = new Map<string, { direct?: string; peeled?: string }>();
  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const [sha, ref, ...rest] = line.split("\t");
    if (!sha || !ref || rest.length > 0 || !fullCommitPattern.test(sha)) {
      fail("Remote returned invalid installable tag metadata.");
    }
    const match = /^refs\/tags\/(lastcode\/(?:checkpoint|revision)\/v.+?)(\^\{\})?$/u.exec(ref);
    if (!match) continue;
    const [, tag, peeledSuffix] = match;
    if (!tag || parseInstallableTag(tag) === null) continue;
    const current = refs.get(tag) ?? {};
    const key = peeledSuffix ? "peeled" : "direct";
    const previous = current[key];
    if (previous && previous !== sha) fail(`Remote returned conflicting metadata for ${tag}.`);
    refs.set(tag, { ...current, [key]: sha });
  }

  const candidates = [...refs.entries()].flatMap(([tag, value]) => {
    const parsed = parseInstallableTag(tag);
    const commit = value.peeled ?? value.direct;
    return parsed && commit ? [{ commit, parsed, tag }] : [];
  });
  candidates.sort((left, right) => compareInstallables(right.parsed, left.parsed));
  const latest = candidates[0];
  if (!latest) fail("Remote does not advertise an installable LastCode tag.");
  return { tag: latest.tag, commit: latest.commit };
}

export function resolveLatestRemoteInstallable(remote = "origin"): {
  readonly tag: string;
  readonly commit: string;
} {
  return latestInstallableFromRemoteRefs(
    runCommand("git", [
      "ls-remote",
      "--tags",
      remote,
      "refs/tags/lastcode/checkpoint/v*",
      "refs/tags/lastcode/revision/v*",
    ]),
  );
}

export async function buildLatestIntelPackage(
  input: {
    readonly resolveLatest?: typeof resolveLatestRemoteInstallable;
    readonly select?: typeof selectIntelBuild;
    readonly run?: typeof runSelectedIntelBuild;
  } = {},
) {
  const target = (input.resolveLatest ?? resolveLatestRemoteInstallable)();
  const withoutLocalLock = <T>(operation: () => T): T => operation();
  const request = (input.select ?? selectIntelBuild)(target.tag, {
    resolveTag: () => target,
    withRequestLock: withoutLocalLock,
  });
  console.log(`[daily-intel] Selected ${request.installableTag} at ${request.installableCommit}.`);
  return (input.run ?? runSelectedIntelBuild)({
    ...createBuildIntelDependencies(),
    withRequestLock: withoutLocalLock,
  });
}

if (import.meta.main) {
  buildLatestIntelPackage()
    .then((result) => console.log(`[daily-intel] Result ${JSON.stringify(result)}`))
    .catch((error: unknown) => {
      console.error(`[daily-intel] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
