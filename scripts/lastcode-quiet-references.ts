// @effect-diagnostics nodeBuiltinImport:off -- Checkpoint generation rewrites local Git objects.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cleanGitEnvironment } from "./lastcode-nightly.ts";

const LOCAL_REPOSITORY = "lastobelus/lastcode";

/** Keep provenance clickable without creating another upstream timeline entry. */
export function normalizeCheckpointMessage(message: string): string {
  return message
    .replace(
      /(?<![\w./:@-])https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/([1-9]\d*)(?=$|[\s/#?.,;:!"'`)\]}<>])/giu,
      (url: string, repository: string, kind: string, number: string) =>
        repository.toLowerCase() === LOCAL_REPOSITORY
          ? url
          : `https://redirect.github.com/${repository}/${kind}/${number}`,
    )
    .replace(
      /(?<![\w./:@-])([\w.-]+\/[\w.-]+)#([1-9]\d*)(?![\w])/gu,
      (reference: string, repository: string, number: string) =>
        repository.toLowerCase() === LOCAL_REPOSITORY
          ? reference
          : `https://redirect.github.com/${repository}/issues/${number}`,
    );
}

function git(worktree: string, args: ReadonlyArray<string>, input?: Buffer): Buffer {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: worktree,
    env: cleanGitEnvironment(process.env),
    maxBuffer: 64 * 1024 * 1024,
    ...(input ? { input } : {}),
  });
}

function gitText(worktree: string, args: ReadonlyArray<string>): string {
  return git(worktree, args).toString("utf8").trim();
}

function assertClean(worktree: string): void {
  if (gitText(worktree, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Checkpoint message normalization requires a clean worktree.");
  }
  const gitDirectory = gitText(worktree, ["rev-parse", "--absolute-git-dir"]);
  for (const state of [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    if (NodeFS.existsSync(NodePath.join(gitDirectory, state))) {
      throw new Error("Checkpoint message normalization requires completed Git operations.");
    }
  }
}

function normalizedCheckpointHead(
  worktree: string,
  upstreamBase: string,
  originalHead: string,
): string {
  const base = gitText(worktree, ["rev-parse", "--verify", `${upstreamBase}^{commit}`]);
  git(worktree, ["merge-base", "--is-ancestor", base, originalHead]);
  const commits = gitText(worktree, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${base}..${originalHead}`,
  ])
    .split("\n")
    .filter(Boolean);
  const rewrittenCommits = new Map<string, string>();
  for (const commit of commits) {
    const raw = git(worktree, ["cat-file", "commit", commit]);
    const separator = raw.indexOf("\n\n");
    if (separator < 0) throw new Error(`Invalid checkpoint commit ${commit}.`);
    const headers = raw.subarray(0, separator).toString("utf8");
    const message = raw.subarray(separator + 2).toString("utf8");
    if (!Buffer.from(`${headers}\n\n${message}`).equals(raw)) {
      throw new Error(`Checkpoint commit ${commit} is not UTF-8; refusing to alter its bytes.`);
    }
    const mappedHeaders = headers.replace(
      /^parent ([0-9a-f]+)$/gmu,
      (line: string, parent: string) =>
        rewrittenCommits.has(parent) ? `parent ${rewrittenCommits.get(parent)}` : line,
    );
    const normalized = normalizeCheckpointMessage(message);
    if (mappedHeaders === headers && normalized === message) {
      rewrittenCommits.set(commit, commit);
    } else {
      // Signatures and embedded merge tags authenticate the original objects.
      // Keep those on the source, not on rewritten commits or merge parents.
      const rewrittenHeaders = mappedHeaders.replace(
        /\n(?:gpgsig(?:-sha256)?|mergetag) [^\n]*(?:\n [^\n]*)*/gu,
        "",
      );
      const rewritten = git(
        worktree,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        Buffer.from(`${rewrittenHeaders}\n\n${normalized}`),
      )
        .toString("utf8")
        .trim();
      rewrittenCommits.set(commit, rewritten);
    }
  }
  return rewrittenCommits.get(originalHead) ?? originalHead;
}

/** Recognize only our exact deterministic rewrite after an interrupted record update. */
export function isCheckpointMessageRewrite(
  worktree: string,
  upstreamBase: string,
  beforeHead: string,
  afterHead: string,
): boolean {
  if (beforeHead === afterHead) return true;
  try {
    return normalizedCheckpointHead(worktree, upstreamBase, beforeHead) === afterHead;
  } catch {
    // Missing or unrelated recorded commits cannot prove a safe recovery.
    return false;
  }
}

/** Rewrite only the generated candidate, never upstream or immutable source refs. */
export function normalizeCheckpointCommits(worktree: string, upstreamBase: string): string {
  assertClean(worktree);
  const originalHead = gitText(worktree, ["rev-parse", "HEAD"]);
  const parent = normalizedCheckpointHead(worktree, upstreamBase, originalHead);
  if (parent !== originalHead) {
    assertClean(worktree);
    if (
      gitText(worktree, ["rev-parse", `${parent}^{tree}`]) !==
      gitText(worktree, ["rev-parse", `${originalHead}^{tree}`])
    ) {
      throw new Error("Checkpoint message normalization changed the candidate tree.");
    }
    git(worktree, [
      "update-ref",
      "-m",
      "quiet checkpoint references",
      "HEAD",
      parent,
      originalHead,
    ]);
  }
  return parent;
}
