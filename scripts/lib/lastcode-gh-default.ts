// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - worktree setup runs before dependencies exist.
import * as NodeChildProcess from "node:child_process";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });

/**
 * LastCode PRs target the fork, so make `origin` gh's default repository, as
 * `gh repo set-default` does. Otherwise gh, and T3's PR tools that follow it, pick
 * `upstream` and open PRs on the public parent.
 */
export function markOriginAsGhDefault(cwd: string): void {
  const origin = git(cwd, ["remote", "get-url", "origin"]);
  // gh ignores a mark on a non-GitHub origin, such as a forge mirror; keep the existing default.
  if (origin.status !== 0 || !/(?:^|[@/])github\.com[:/]/iu.test(origin.stdout.trim())) return;
  const marks = git(cwd, ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"])
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/u));
  const [only, ...rest] = marks;
  if (rest.length === 0 && only?.[0] === "remote.origin.gh-resolved" && only[1] === "base") return;
  for (const [key] of marks) git(cwd, ["config", "--unset-all", key!]);
  const result = git(cwd, ["config", "remote.origin.gh-resolved", "base"]);
  if (result.status !== 0) {
    console.warn(`[setup-worktree] Could not make origin gh's default: ${result.stderr.trim()}`);
  }
}
