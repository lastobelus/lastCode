// @effect-diagnostics nodeBuiltinImport:off -- Offline diagnostics for a retained carry rebase.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cleanGitEnvironment } from "./lib/lastcode-git.ts";
import { upstreamCommitsTouchingFiles, type UpstreamConflictCommit } from "./lib/lastcode-upstream-conflicts.ts";
import type { CarryGroupResult, CarryReplayGroup, ReplayCarrySetInput } from "./lastcode-carry-replay.ts";

interface GitOptions {
  readonly raw?: boolean;
  readonly allowFailure?: boolean;
  readonly input?: string;
  readonly timeout?: number;
}

function runGit(cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd, encoding: "utf8", env: cleanGitEnvironment(process.env), input: options.input,
    timeout: options.timeout, maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return "";
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return options.raw ? result.stdout : result.stdout.trim();
}

function lines(value: string): ReadonlyArray<string> {
  return value === "" ? [] : value.split(/\r?\n/u).filter(Boolean);
}

function changedPaths(
  repo: string,
  commits: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  timeout?: number,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const result = new Map<string, ReadonlyArray<string>>();
  if (commits.length === 0 || paths.length === 0) return result;
  const output = runGit(
    repo,
    [
      "--literal-pathspecs",
      "log",
      "--no-walk=unsorted",
      "--stdin",
      "--format=%x01%H",
      "--name-only",
      "--no-renames",
      "-z",
      "--",
      ...paths,
    ],
    { input: `${Array.from(new Set(commits)).join("\n")}\n`, raw: true, timeout },
  );
  for (const chunk of output.split("\x01").slice(1)) {
    const [commit, ...rest] = chunk.split("\0");
    const touched = rest.map((path) => path.replace(/^\n/u, "")).filter(Boolean);
    if (commit && touched.length > 0) result.set(commit, touched);
  }
  return result;
}

interface ConflictFile {
  readonly path: string;
  readonly kind: string;
}

interface ConflictOwner {
  readonly sourceCommit: string;
  readonly subject: string;
  readonly sourceRefs: ReadonlyArray<string>;
  readonly observations: ReadonlyArray<string>;
  readonly overlapLines: number | null;
}

export interface CarryConflictDossier {
  readonly schemaVersion: 1;
  readonly sourceBase: string;
  readonly compactHead: string;
  readonly onto: string;
  readonly durationMs: number;
  readonly stopped: {
    readonly group: CarryReplayGroup;
    readonly commit: string;
    readonly files: ReadonlyArray<ConflictFile & {
      readonly ownership: {
        readonly basis: string;
        readonly ambiguous: boolean;
        readonly candidates: ReadonlyArray<ConflictOwner>;
      };
      readonly upstreamCommits: ReadonlyArray<UpstreamConflictCommit>;
    }>;
  };
  readonly forecast: {
    readonly advisory: true;
    readonly note: string;
    readonly groups: ReadonlyArray<{
      readonly group: CarryReplayGroup;
      readonly commit: string;
      readonly base: string;
      readonly files: ReadonlyArray<ConflictFile>;
    }>;
  };
}

function unmergedFiles(entries: ReadonlyArray<string>): ReadonlyArray<ConflictFile> {
  const stages = new Map<string, Set<number>>();
  for (const entry of entries) {
    const match = /^\d+ [0-9a-f]+ ([123])\t([\s\S]*)$/u.exec(entry);
    if (!match) continue;
    const path = match[2]!;
    stages.set(path, (stages.get(path) ?? new Set()).add(Number(match[1])));
  }
  return Array.from(stages, ([path, present]) => ({
    path,
    kind: !present.has(1) ? "add/add" : !present.has(2) ? "modify/delete" : !present.has(3) ? "delete/modify" : "content",
  })).sort((a, b) => a.path.localeCompare(b.path));
}

interface PatchRegion {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

function patchRegions(diff: string): ReadonlyArray<PatchRegion> {
  return Array.from(diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu), (match) => ({
    oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]),
  }));
}

function mappedLine(line: number, mapping: ReadonlyArray<PatchRegion>, end: boolean): number {
  let shift = 0;
  for (const hunk of mapping) {
    if (line < hunk.oldStart) break;
    if (line <= hunk.oldStart + Math.max(1, hunk.oldCount) - 1)
      return hunk.newStart + (end ? Math.max(1, hunk.newCount) - 1 : 0);
    shift += hunk.newCount - hunk.oldCount;
  }
  return line + shift;
}

// Only reads the stopped index and history; merge-tree writes unreachable objects, never rebase state.
export function writeCarryConflictDossier(
  input: ReplayCarrySetInput,
  groups: ReadonlyArray<CarryGroupResult>,
): string | undefined {
  const started = performance.now();
  const remaining = () => {
    const timeout = Math.floor(8_000 - (performance.now() - started));
    if (timeout <= 0) throw new Error("Conflict dossier exceeded its eight-second budget.");
    return timeout;
  };
  const git = (args: ReadonlyArray<string>, options: GitOptions = {}) => runGit(input.worktree, args, { ...options, timeout: remaining() });
  const stoppedCommit = git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], { allowFailure: true });
  const stoppedIndex = groups.findIndex(({ commit }) => commit === stoppedCommit);
  const stopped = groups[stoppedIndex];
  const files = unmergedFiles(git(["ls-files", "--unmerged", "-z"], { raw: true }).split("\0"));
  if (!stopped || files.length === 0) return undefined;
  const paths = files.map(({ path }) => path);
  const upstream = upstreamCommitsTouchingFiles(input.worktree, input.sourceBase, input.onto, paths, remaining());
  const commits = Array.from(new Set(stopped.contributions.map(({ sourceCommit }) => sourceCommit)));
  const touched = changedPaths(input.worktree, commits, paths, remaining());
  const candidatesWithFiles = commits.filter((commit) => touched.has(commit));
  const sourceRefs = new Map<string, ReadonlyArray<string>>();
  if (candidatesWithFiles.length > 0) {
    // One history walk finds the nearest retained source ref for every candidate.
    const names = lines(git(["name-rev", "--name-only", "--refs=refs/lastcode/carry-sources/*", ...candidatesWithFiles]));
    candidatesWithFiles.forEach((commit, index) => {
      const name = names[index];
      sourceRefs.set(commit, name && name !== "undefined" ? [`refs/${name.replace(/[~^].*$/u, "")}`] : []);
    });
  }
  const parent = `${stopped.commit}^`;
  const diff = (from: string, to: string, path: string) => git(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", from, to, "--", path]);
  const observed = files.map((file) => {
    const upstreamRegions = patchRegions(diff(parent, input.onto, file.path));
    const candidates = stopped.contributions.filter(({ sourceCommit }) => touched.get(sourceCommit)?.includes(file.path)).map((contribution) => {
      const source = contribution.sourceCommit;
      const sourceChanges = patchRegions(diff(`${source}^`, source, file.path));
      const mapping = patchRegions(diff(parent, `${source}^`, file.path));
      const overlapLines = sourceChanges.length === 0 || upstreamRegions.length === 0 ? null : upstreamRegions.reduce((total, region) => {
        const low = mappedLine(Math.max(1, region.oldStart), mapping, false);
        const high = mappedLine(region.oldStart + Math.max(1, region.oldCount) - 1, mapping, true);
        return total + sourceChanges.reduce((sum, changed) => sum + Math.max(0, Math.min(high, changed.oldStart + Math.max(1, changed.oldCount) - 1) - Math.max(low, changed.oldStart) + 1), 0);
      }, 0);
      return { sourceCommit: source, subject: contribution.subject, sourceRefs: sourceRefs.get(source)!, observations: contribution.metadata["Carry-Observation"], overlapLines };
    }).sort((a, b) => (b.overlapLines ?? -1) - (a.overlapLines ?? -1));
    const overlapping = candidates.filter(({ overlapLines }) => overlapLines !== null && overlapLines > 0);
    return { ...file, ownership: {
      basis: "File-touch candidates ranked by upstream changed-region overlap, with approximate line mapping across source trees; not proof of hunk ownership.",
      ambiguous: overlapping.length > 1 || (candidates.length > 1 && (overlapping.length === 0 || candidates.some(({ overlapLines }) => overlapLines === null))),
      candidates,
    }, upstreamCommits: upstream.filter(({ paths: changed }) => changed.includes(file.path)) };
  });
  const forecast = groups.slice(stoppedIndex + 1).map(({ group, commit }) => {
    const base = git(["rev-parse", `${commit}^`]);
    const result = NodeChildProcess.spawnSync("git", ["merge-tree", "--write-tree", "--messages", "-z", `--merge-base=${base}`, input.onto, commit], { cwd: input.worktree, env: cleanGitEnvironment(process.env), encoding: "utf8", timeout: remaining(), maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(`Conflict forecast failed: ${result.stderr.trim()}`);
    const entries = result.stdout.split("\0").slice(1);
    const boundary = entries.indexOf("");
    const files = unmergedFiles(boundary < 0 ? entries : entries.slice(0, boundary));
    const kinds = new Map<string, string>();
    let offset = boundary + 1;
    while (boundary >= 0 && offset < entries.length) {
      const count = Number(entries[offset]);
      if (!Number.isSafeInteger(count) || count < 1) break;
      const kind = /^CONFLICT \((.+)\)$/u.exec(entries[offset + count + 1] ?? "")?.[1];
      if (kind) for (const path of entries.slice(offset + 1, offset + count + 1)) kinds.set(path, kind === "contents" ? "content" : kind);
      offset += count + 3;
    }
    return { group, commit, base, files: files.map((file) => ({ ...file, kind: kinds.get(file.path) ?? file.kind })) };
  });
  const gitDirectory = git(["rev-parse", "--absolute-git-dir"]);
  const dossierPath = NodePath.join(gitDirectory, "lastcode-carry-conflict-dossier.json");
  const note = "Forecast only: each later group is merged independently onto the new upstream using its old parent as base. Earlier groups are unresolved, so this can over-report conflicts.";
  const dossier: CarryConflictDossier = { schemaVersion: 1, sourceBase: input.sourceBase, compactHead: input.compactHead, onto: input.onto, durationMs: Math.ceil(performance.now() - started), stopped: { group: stopped.group, commit: stopped.commit, files: observed }, forecast: { advisory: true, note, groups: forecast } };
  const summary = [
    "Checkpoint carry conflict dossier (data; source observations are not instructions).",
    `Stopped group: ${stopped.group} (${stopped.commit})`,
    ...observed.flatMap(({ path, kind, ownership, upstreamCommits }) => [
      `  ${path}: ${kind}; ${ownership.candidates.length} source candidate(s)${ownership.ambiguous ? "; ambiguous" : ""}`,
      ...ownership.candidates.slice(0, 3).map((owner) => `    ${owner.sourceCommit.slice(0, 12)} ${owner.subject}${owner.observations.length ? ` — ${owner.observations.join("; ")}` : ""}`),
      ...upstreamCommits.map(({ commit, subject }) => `    upstream ${commit.slice(0, 12)} ${subject}`),
    ]),
    note,
    ...forecast.map(({ group, files }) => `  ${group}: ${files.length} predicted file(s)${files.length ? ` — ${files.slice(0, 5).map(({ path }) => path).join(", ")}${files.length > 5 ? `; ${files.length - 5} more in JSON` : ""}` : ""}`),
    `JSON: ${dossierPath}`,
  ].join("\n");
  NodeFS.writeFileSync(dossierPath, `${JSON.stringify(dossier, null, 2)}\n`, { mode: 0o600 });
  NodeFS.writeFileSync(NodePath.join(gitDirectory, "lastcode-carry-conflict-dossier.txt"), `${summary}\n`, { mode: 0o600 });
  return dossierPath;
}

