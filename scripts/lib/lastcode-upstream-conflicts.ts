// @effect-diagnostics nodeBuiltinImport:off -- Shared offline checkpoint diagnostics.
import * as NodeChildProcess from "node:child_process";

import { cleanGitEnvironment } from "./lastcode-git.ts";

export interface UpstreamConflictCommit {
  readonly commit: string;
  readonly abbreviatedCommit: string;
  readonly subject: string;
  readonly paths: ReadonlyArray<string>;
}

export function upstreamCommitsTouchingFiles(
  repo: string,
  oldBase: string,
  newBase: string,
  paths: ReadonlyArray<string>,
  timeout?: number,
): ReadonlyArray<UpstreamConflictCommit> {
  if (paths.length === 0) return [];
  const output = NodeChildProcess.execFileSync("git", [
    "--literal-pathspecs", "log", "--format=%x01%H%x00%h%x00%s", "--name-only", "--no-renames", "-z",
    `${oldBase}..${newBase}`, "--", ...paths,
  ], { cwd: repo, env: cleanGitEnvironment(process.env), encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  return output.split("\x01").slice(1).map((chunk) => {
    const [commit = "", abbreviatedCommit = "", subject = "", ...rest] = chunk.split("\0");
    return { commit, abbreviatedCommit, subject, paths: rest.map((path) => path.replace(/^\n/u, "")).filter(Boolean) };
  });
}
