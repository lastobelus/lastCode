#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- CI validates exact Git objects from the pull-request event.
import * as NodeChildProcess from "node:child_process";

import {
  shouldRetainCarrySources,
  validateCarrySourceRange,
  type CarryReplayManifest,
  type CarrySourceDelivery,
} from "./lastcode-carry-delivery.ts";
import { CARRY_REPLAY_GROUPS } from "./lastcode-carry-replay.ts";

const CARRY_MANIFEST_PATH = "scripts/lastcode-carry-set.json";

export interface CarryCiPullRequest {
  readonly base: string;
  readonly head: string;
  readonly number: number;
}

export interface CarryCiResult {
  readonly active: boolean;
  readonly source?: CarrySourceDelivery;
}

function git(
  repoRoot: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
): string | undefined {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return undefined;
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function exactCommit(value: string, name: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`Carry CI requires the exact 40-character pull-request ${name} commit.`);
  }
  return value;
}

function manifestAtCommit(repoRoot: string, commit: string): CarryReplayManifest | undefined {
  if (
    git(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`], { allowFailure: true }) !==
    commit
  ) {
    throw new Error(
      `Pull-request commit ${commit} is unavailable. Fetch the complete base-to-head history before validating carry groups.`,
    );
  }
  const contents = git(repoRoot, ["show", `${commit}:${CARRY_MANIFEST_PATH}`], {
    allowFailure: true,
  });
  if (contents === undefined) return undefined;
  const manifest: unknown = JSON.parse(contents);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${CARRY_MANIFEST_PATH} at ${commit} must contain a JSON object.`);
  }
  return manifest as CarryReplayManifest;
}

export function validateCarryPullRequest(
  repoRoot: string,
  pullRequest: CarryCiPullRequest,
): CarryCiResult {
  const base = exactCommit(pullRequest.base, "base");
  const head = exactCommit(pullRequest.head, "head");
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) {
    throw new Error("Carry CI requires a positive pull-request number.");
  }
  const active = [manifestAtCommit(repoRoot, base), manifestAtCommit(repoRoot, head)].some(
    (manifest) => manifest !== undefined && shouldRetainCarrySources(manifest),
  );
  if (!active) return { active: false };

  try {
    return {
      active: true,
      source: validateCarrySourceRange(repoRoot, pullRequest.number, base, head),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PR #${pullRequest.number} carry validation failed for exact range ${base}..${head}: ${detail} Add exactly one Carry-Group trailer to every commit using one of: ${CARRY_REPLAY_GROUPS.join(", ")}. Keep the PR history linear, then push the corrected head.`,
      { cause: error },
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Carry CI requires ${name}.`);
  return value;
}

export function pullRequestFromEnvironment(): CarryCiPullRequest {
  const number = Number(requiredEnvironment("PR_NUMBER"));
  return {
    base: requiredEnvironment("BASE_SHA"),
    head: requiredEnvironment("HEAD_SHA"),
    number,
  };
}

if (import.meta.main) {
  try {
    const pullRequest = pullRequestFromEnvironment();
    const result = validateCarryPullRequest(process.cwd(), pullRequest);
    if (result.active) {
      console.log(
        `[lastcode:carry-ci] Validated Carry-Group assignments for PR #${pullRequest.number} at ${pullRequest.base}..${pullRequest.head}.`,
      );
    } else {
      console.log("[lastcode:carry-ci] Carry replay is inactive on both PR base and head.");
    }
  } catch (error) {
    console.error(`[lastcode:carry-ci] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
