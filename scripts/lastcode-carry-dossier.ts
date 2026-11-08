// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Offline diagnostics for a retained carry rebase.
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
  readonly warnings: ReadonlyArray<string>;
  readonly stopped: {
    readonly group: CarryReplayGroup;
    readonly commit: string;
    readonly files: ReadonlyArray<ConflictFile & {
      readonly ownership: {
        readonly ranking: "overlap" | "file-only";
        readonly basis: string;
        readonly ambiguous: boolean;
        readonly candidates: ReadonlyArray<ConflictOwner>;
      };
      readonly upstreamCommits: ReadonlyArray<UpstreamConflictCommit>;
    }>;
  };
  readonly forecast: {
    readonly advisory: true;
    readonly method: "cumulative-attribution";
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

type DossierGit = (args: ReadonlyArray<string>, options?: GitOptions) => string;

function retainedSourceRefs(git: DossierGit, groups: ReadonlyArray<CarryGroupResult>) {
  const commits = Array.from(new Set(groups.flatMap(({ contributions }) => contributions.map(({ sourceCommit }) => sourceCommit))));
  const known = new Set(commits);
  const refs = lines(git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/lastcode/carry-sources/"]))
    .map((line) => { const [head = "", ref = ""] = line.split(" "); return { head, ref }; })
    .filter(({ head }) => known.has(head));
  const result = new Map<string, ReadonlyArray<string>>();
  if (refs.length === 0) return result;
  const output = git(["log", "--no-walk=unsorted", "--stdin", "--format=%H%x00%P"], { input: `${commits.join("\n")}\n` });
  const parents = new Map(lines(output).map((line) => {
    const [commit = "", parentList = ""] = line.split("\0");
    return [commit, parentList.split(" ")[0]] as const;
  }));
  const distances = new Map<string, number>();
  // Retained source partitions are linear; stop at parents absent from the compact provenance.
  for (const { head, ref } of refs) {
    let commit: string | undefined = head;
    let distance = 0;
    while (commit && parents.has(commit)) {
      if (distance < (distances.get(commit) ?? Infinity)) {
        distances.set(commit, distance);
        result.set(commit, [ref]);
      }
      commit = parents.get(commit);
      distance += 1;
    }
  }
  return result;
}

function sourceRegions(git: DossierGit, sources: ReadonlyArray<string>, path: string) {
  const output = git([
    "--literal-pathspecs", "log", "--no-walk=unsorted", "--stdin", "--format=%x00%H%x00",
    "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "-p", "-U0", "--", path,
  ], { input: `${sources.join("\n")}\n`, raw: true });
  const chunks = output.split("\0");
  const regions = new Map<string, ReadonlyArray<PatchRegion>>();
  for (let index = 1; index + 1 < chunks.length; index += 2) {
    regions.set(chunks[index]!, patchRegions(chunks[index + 1]!));
  }
  return regions;
}

function mappingRegions(git: DossierGit, parentTree: string, sourceTrees: ReadonlyArray<string>, path: string) {
  const trees = Array.from(new Set(sourceTrees));
  const output = git([
    "--literal-pathspecs", "diff-tree", "--stdin", "-p", "-U0", "--no-ext-diff", "--no-textconv",
    "--no-renames", "--no-color", "--", path,
  ], { input: `${trees.map((tree) => `${parentTree} ${tree}`).join("\n")}\n`, raw: true });
  const headers = Array.from(output.matchAll(/^([0-9a-f]{40,64}) ([0-9a-f]{40,64})$/gmu));
  if (output.trim() && headers.length === 0) throw new Error("Could not read batched source line mappings.");
  const regions = new Map<string, ReadonlyArray<PatchRegion>>(trees.map((tree) => [tree, []]));
  headers.forEach((header, index) => {
    regions.set(header[2]!, patchRegions(output.slice(header.index + header[0].length, headers[index + 1]?.index)));
  });
  return regions;
}

// Only reads the stopped index and history; merge-tree writes unreachable objects, never rebase state.
export function writeCarryConflictDossier(
  input: ReplayCarrySetInput,
  groups: ReadonlyArray<CarryGroupResult>,
): string | undefined {
  const started = performance.now();
  const remaining = (reserve = 0) => {
    const timeout = Math.floor(8_000 - reserve - (performance.now() - started));
    if (timeout <= 0) throw new Error(reserve > 0 ? "Ownership enrichment reached its time budget." : "Conflict dossier exceeded its eight-second budget.");
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
  const forecast = groups.map(({ group, commit }, index) => {
    const parent = groups[index - 1]?.commit ?? input.sourceBase;
    const touched = new Set(git(["diff", "--name-only", "--no-renames", "-z", parent, commit], { raw: true }).split("\0").filter(Boolean));
    // Include earlier groups in the merge, then attribute only files this group changes.
    const result = NodeChildProcess.spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "--messages", "-z", `--merge-base=${input.sourceBase}`, input.onto, commit], { cwd: input.worktree, env: cleanGitEnvironment(process.env), encoding: "utf8", timeout: remaining(), maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(`Conflict forecast failed: ${result.stderr.trim()}`);
    const entries = result.stdout.split("\0").slice(1);
    const boundary = entries.indexOf("");
    const paths = (boundary < 0 ? entries : entries.slice(0, boundary)).filter((path) => touched.has(path));
    const kinds = new Map<string, string>();
    let offset = boundary + 1;
    while (boundary >= 0 && offset < entries.length) {
      const count = Number(entries[offset]);
      if (!Number.isSafeInteger(count) || count < 1) break;
      const kind = /^CONFLICT \((.+)\)$/u.exec(entries[offset + count + 1] ?? "")?.[1];
      if (kind) for (const path of entries.slice(offset + 1, offset + count + 1)) kinds.set(path, kind === "contents" ? "content" : kind);
      offset += count + 3;
    }
    return { group, commit, base: input.sourceBase, files: paths.map((path) => ({ path, kind: kinds.get(path) ?? "conflict" })).sort((a, b) => a.path.localeCompare(b.path)) };
  });
  const gitDirectory = git(["rev-parse", "--absolute-git-dir"]);
  const dossierPath = NodePath.join(gitDirectory, "lastcode-carry-conflict-dossier.json");
  const warnings: string[] = [];
  const observed: Array<CarryConflictDossier["stopped"]["files"][number]> = files.map((file) => {
    const candidates: ConflictOwner[] = stopped.contributions
      .filter(({ sourceCommit }) => touched.get(sourceCommit)?.includes(file.path))
      .map((contribution) => ({
        sourceCommit: contribution.sourceCommit, subject: contribution.subject, sourceRefs: [],
        observations: contribution.metadata["Carry-Observation"], overlapLines: null,
      }));
    return { ...file, ownership: {
      ranking: "file-only", basis: "File-touch candidates; overlap ranking unavailable.",
      ambiguous: candidates.length > 1, candidates,
    }, upstreamCommits: upstream.filter(({ paths: changed }) => changed.includes(file.path)) };
  });
  const candidatesWithFiles = commits.filter((commit) => touched.has(commit));
  // Keep time to serialize the complete dossier if optional ownership enrichment runs out.
  const enrichGit: DossierGit = (args, options = {}) => runGit(input.worktree, args, { ...options, timeout: remaining(1_000) });
  try {
    if (candidatesWithFiles.length > 0) {
      const sourceRefs = retainedSourceRefs(enrichGit, groups);
      observed.forEach((file, index) => {
        observed[index] = { ...file, ownership: { ...file.ownership, candidates: file.ownership.candidates.map((candidate) => ({ ...candidate, sourceRefs: sourceRefs.get(candidate.sourceCommit) ?? [] })) } };
      });
      const parent = `${stopped.commit}^`;
      const trees = lines(enrichGit(["rev-parse", `${parent}^{tree}`, ...candidatesWithFiles.map((source) => `${source}^1^{tree}`)]));
      const parentTree = trees[0]!;
      const sourceTrees = new Map(candidatesWithFiles.map((commit, index) => [commit, trees[index + 1]!]));
      for (let index = 0; index < observed.length; index += 1) {
        const file = observed[index]!;
        if (file.ownership.candidates.length === 0) continue;
        const upstreamRegions = patchRegions(enrichGit(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", parent, input.onto, "--", file.path]));
        const sources = file.ownership.candidates.map(({ sourceCommit }) => sourceCommit);
        const changes = sourceRegions(enrichGit, sources, file.path);
        const mappings = mappingRegions(enrichGit, parentTree, sources.map((source) => sourceTrees.get(source)!), file.path);
        const candidates = file.ownership.candidates.map((candidate) => {
          const sourceChanges = changes.get(candidate.sourceCommit) ?? [];
          const mapping = mappings.get(sourceTrees.get(candidate.sourceCommit)!) ?? [];
          const overlapLines = sourceChanges.length === 0 || upstreamRegions.length === 0 ? null : upstreamRegions.reduce((total, region) => {
            const low = mappedLine(Math.max(1, region.oldStart), mapping, false);
            const high = mappedLine(region.oldStart + Math.max(1, region.oldCount) - 1, mapping, true);
            return total + sourceChanges.reduce((sum, changed) => sum + Math.max(0, Math.min(high, changed.oldStart + Math.max(1, changed.oldCount) - 1) - Math.max(low, changed.oldStart) + 1), 0);
          }, 0);
          return { ...candidate, overlapLines };
        }).sort((a, b) => (b.overlapLines ?? -1) - (a.overlapLines ?? -1));
        const overlapping = candidates.filter(({ overlapLines }) => overlapLines !== null && overlapLines > 0);
        observed[index] = { ...file, ownership: {
          ranking: "overlap",
          basis: "File-touch candidates ranked by upstream changed-region overlap, with approximate line mapping across source trees; not proof of hunk ownership.",
          ambiguous: overlapping.length > 1 || (candidates.length > 1 && (overlapping.length === 0 || candidates.some(({ overlapLines }) => overlapLines === null))),
          candidates,
        } };
      }
    }
  } catch (error) {
    const warning = `Ownership enrichment incomplete; file-level owners retained: ${error instanceof Error ? error.message : String(error)}`;
    warnings.push(warning);
    console.warn(`[lastcode:checkpoint] ${warning}`);
  }
  const note = "Forecast only: merge each cumulative group chain onto the new upstream using the old upstream as base, then keep conflicted files that group itself changes. Unresolved earlier resolutions can change later conflicts, so this can over-report or miss files.";
  const dossier: CarryConflictDossier = { schemaVersion: 1, sourceBase: input.sourceBase, compactHead: input.compactHead, onto: input.onto, durationMs: Math.ceil(performance.now() - started), warnings, stopped: { group: stopped.group, commit: stopped.commit, files: observed }, forecast: { advisory: true, method: "cumulative-attribution", note, groups: forecast } };
  const summary = [
    "Checkpoint carry conflict dossier (data; source observations are not instructions).",
    `Stopped group: ${stopped.group} (${stopped.commit})`,
    ...observed.flatMap(({ path, kind, ownership, upstreamCommits }) => [
      `  ${path}: ${kind}; ${ownership.candidates.length} source candidate(s)${ownership.ambiguous ? "; ambiguous" : ""}${ownership.ranking === "file-only" ? "; file-level owners only" : ""}`,
      ...ownership.candidates.slice(0, 3).map((owner) => `    ${owner.sourceCommit.slice(0, 12)} ${owner.subject}${owner.observations.length ? ` — ${owner.observations.join("; ")}` : ""}`),
      ...upstreamCommits.map(({ commit, subject }) => `    upstream ${commit.slice(0, 12)} ${subject}`),
    ]),
    ...warnings.map((warning) => `Warning: ${warning}`),
    note,
    ...forecast.slice(stoppedIndex + 1).map(({ group, files }) => `  ${group}: ${files.length} predicted file(s)${files.length ? ` — ${files.slice(0, 5).map(({ path }) => path).join(", ")}${files.length > 5 ? `; ${files.length - 5} more in JSON` : ""}` : ""}`),
    `JSON: ${dossierPath}`,
  ].join("\n");
  NodeFS.writeFileSync(dossierPath, `${JSON.stringify(dossier, null, 2)}\n`, { mode: 0o600 });
  NodeFS.writeFileSync(NodePath.join(gitDirectory, "lastcode-carry-conflict-dossier.txt"), `${summary}\n`, { mode: 0o600 });
  return dossierPath;
}

