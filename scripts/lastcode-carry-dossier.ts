// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Offline diagnostics for a retained carry rebase.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import { cleanGitEnvironment } from "./lib/lastcode-git.ts";
import {
  upstreamCommitsTouchingFiles,
  type UpstreamConflictCommit,
} from "./lib/lastcode-upstream-conflicts.ts";
import type {
  CarryContributionMetadata,
  CarryGroupResult,
  CarryReplayGroup,
  ReplayCarrySetInput,
} from "./lastcode-carry-replay.ts";

interface GitOptions {
  readonly raw?: boolean;
  readonly allowFailure?: boolean;
  readonly input?: string;
  readonly timeout?: number;
}

function runGit(cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}): string {
  const directory = options.input === undefined ? undefined : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-input-"));
  let descriptor: number | undefined;
  try {
    if (directory) {
      const path = NodePath.join(directory, "input");
      NodeFS.writeFileSync(path, options.input!, { mode: 0o600 });
      descriptor = NodeFS.openSync(path, "r");
    }
    const result = NodeChildProcess.spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd, encoding: "utf8", env: cleanGitEnvironment(process.env),
      timeout: options.timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      stdio: [descriptor ?? "ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (options.allowFailure) return "";
      throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    }
    return options.raw ? result.stdout : result.stdout.trim();
  } finally {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

function lines(value: string): ReadonlyArray<string> {
  return value === "" ? [] : value.split(/\r?\n/u).filter(Boolean);
}

function changedPaths(
  repo: string,
  commits: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  timeout: number,
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
      "--name-status",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-z",
      "--",
      ...paths,
    ],
    { input: `${Array.from(new Set(commits)).join("\n")}\n`, raw: true, timeout },
  );
  for (const chunk of output.split("\x01").slice(1)) {
    const [commit, ...rest] = chunk.split("\0");
    const touched = rest.filter((_, index) => index % 2 === 1).filter(Boolean);
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
  readonly ours: string;
  readonly upstreamCommits: ReadonlyArray<UpstreamConflictCommit>;
  readonly warnings: ReadonlyArray<string>;
  readonly stopped: {
    readonly group: CarryReplayGroup;
    readonly commit: string;
    readonly files: ReadonlyArray<
      ConflictFile & {
        readonly ownership: {
          readonly ranking: "overlap" | "file-only";
          readonly basis: string;
          readonly ambiguous: boolean;
          readonly candidates: ReadonlyArray<ConflictOwner>;
        };
        readonly upstreamCommits: ReadonlyArray<string>;
      }
    >;
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
    kind: present.size === 3 ? "content"
      : present.size === 2 && present.has(2) && present.has(3) ? "add/add"
      : present.size === 2 && present.has(1) && present.has(3) ? "deleted upstream"
      : present.size === 2 && present.has(1) && present.has(2) ? "deleted by carry"
      : "conflict",
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
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
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
  const commits = Array.from(
    new Set(
      groups.flatMap(({ contributions }) => contributions.map(({ sourceCommit }) => sourceCommit)),
    ),
  );
  const known = new Set(commits);
  const refs = lines(
    git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/lastcode/carry-sources/"]),
  )
    .map((line) => {
      const [head = "", ref = ""] = line.split(" ");
      return { head, ref };
    })
    .filter(({ head }) => known.has(head));
  const result = new Map<string, ReadonlyArray<string>>();
  if (refs.length === 0) return result;
  const output = git(["log", "--no-walk=unsorted", "--stdin", "--format=%H%x00%P"], {
    input: `${commits.join("\n")}\n`,
  });
  const parents = new Map(
    lines(output).map((line) => {
      const [commit = "", parentList = ""] = line.split("\0");
      return [commit, parentList.split(" ")[0]] as const;
    }),
  );
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

const PATCH_FLAGS = ["--raw", "--no-abbrev", "-z", "-p", "-U0", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];

// Raw NUL-delimited paths precede the patches in the same order, including quoted filenames.
interface FilePatch {
  readonly oldBlob: string;
  readonly regions: ReadonlyArray<PatchRegion>;
}

function regionsByPath(output: string): ReadonlyMap<string, FilePatch> {
  output = output.replace(/^[\0\n]+/u, "");
  const boundary = output.indexOf("\0\0diff --git ");
  if (boundary < 0) return new Map();
  const fields = output.slice(0, boundary + 1).split("\0");
  const paths: Array<{ path: string; oldBlob: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (!/^\s*:[0-7]+ [0-7]+ [0-9a-f]+ [0-9a-f]+ [A-Z]/u.test(fields[index]!))
      throw new Error("Could not read batched patch paths.");
    paths.push({ path: fields[index + 1]!, oldBlob: fields[index]!.trim().split(" ")[2]! });
  }
  const patches = output.slice(boundary + 2).split(/^diff --git /mu).slice(1);
  if (paths.length !== patches.length) throw new Error("Batched patch paths do not match patches.");
  return new Map(paths.map(({ path, oldBlob }, index) => [path, { oldBlob, regions: patchRegions(patches[index]!) }]));
}

function partitionPaths(contribution: CarryContributionMetadata): ReadonlyArray<string> {
  if (contribution.deletedPaths) return contribution.deletedPaths;
  // Older compiled chains recorded deletion partitions in their public provenance notes.
  if (!contribution.metadata["Carry-Observation"].some((note) => note.startsWith("Deletion partition follows the ")))
    return [];
  return contribution.metadata["Carry-Supersedes"].flatMap((note) => {
    const match = /^[0-9a-f]{40,64} \((.*)\)$/u.exec(note);
    return match ? [match[1]!] : [];
  });
}

function ownsPath(contribution: CarryContributionMetadata, path: string, groups: ReadonlyArray<CarryGroupResult>): boolean {
  const deleted = partitionPaths(contribution);
  if (deleted.length > 0) return deleted.includes(path);
  return !groups.some(({ contributions }) => contributions.some((other) =>
    other.sourceCommit === contribution.sourceCommit && partitionPaths(other).includes(path)));
}

function rankOwners(git: DossierGit, stopped: CarryGroupResult, ours: string,
  observed: Array<CarryConflictDossier["stopped"]["files"][number]>, checkBudget: () => number) {
  const paths = observed.map(({ path }) => path);
  const sources = Array.from(new Set(observed.flatMap(({ ownership }) => ownership.candidates.map(({ sourceCommit }) => sourceCommit))));
  if (sources.length === 0) return;
  const parent = `${stopped.commit}^`;
  const upstream = regionsByPath(git(["--literal-pathspecs", "diff", ...PATCH_FLAGS, parent, ours, "--", ...paths], { raw: true }));
  const changes = new Map<string, ReadonlyMap<string, FilePatch>>();
  const sourceOutput = git(["--literal-pathspecs", "log", "--no-walk=unsorted", "--stdin", "--format=%x00%x00%H%x00%P%x00", ...PATCH_FLAGS, "--", ...paths], { input: `${sources.join("\n")}\n`, raw: true });
  const sourceHeaders = Array.from(sourceOutput.matchAll(/\0\0([0-9a-f]{40,64})\0([0-9a-f ]*)\0/gu));
  sourceHeaders.forEach((header, index) => {
    if (!header[2]) throw new Error(`Source parent unavailable for ${header[1]}.`);
    changes.set(header[1]!, regionsByPath(sourceOutput.slice(header.index + header[0].length, sourceHeaders[index + 1]?.index)));
  });
  // Flatten only relevant blob pairs into two temporary trees. Comparing every source tree
  // against every conflicted path would produce a large, mostly irrelevant Cartesian product.
  const oldEntries: string[] = [];
  const newEntries: string[] = [];
  const aliases = new Map<string, string>();
  for (const file of observed) {
    checkBudget();
    const oldBlob = upstream.get(file.path)?.oldBlob;
    if (!oldBlob) continue;
    for (const owner of file.ownership.candidates) {
      const newBlob = changes.get(owner.sourceCommit)?.get(file.path)?.oldBlob;
      if (!newBlob) continue;
      const key = JSON.stringify([file.path, owner.sourceCommit]);
      const alias = String(aliases.size).padStart(6, "0");
      aliases.set(key, alias);
      if (!/^0+$/u.test(oldBlob)) oldEntries.push(`100644 blob ${oldBlob}\t${alias}`);
      if (!/^0+$/u.test(newBlob)) newEntries.push(`100644 blob ${newBlob}\t${alias}`);
    }
  }
  const trees = lines(git(["mktree", "--batch"], { input: [oldEntries, newEntries].map((entries) => `${entries.length ? `${entries.join("\n")}\n` : ""}\n`).join("") }));
  if (trees.length !== 2) throw new Error("Could not build batched line-mapping trees.");
  const mappings = regionsByPath(git(["diff-tree", ...PATCH_FLAGS, trees[0]!, trees[1]!], { raw: true }));
  observed.forEach((file, index) => {
    checkBudget();
    const upstreamRegions = upstream.get(file.path)?.regions ?? [];
    const candidates = file.ownership.candidates.map((candidate) => {
      const sourceChanges = changes.get(candidate.sourceCommit)?.get(file.path)?.regions ?? [];
      const alias = aliases.get(JSON.stringify([file.path, candidate.sourceCommit]));
      const mapping = alias === undefined ? [] : mappings.get(alias)?.regions ?? [];
      const overlapLines = sourceChanges.length === 0 || upstreamRegions.length === 0 ? null : upstreamRegions.reduce((total, region) => {
        const low = mappedLine(Math.max(1, region.oldStart), mapping, false);
        const high = mappedLine(region.oldStart + Math.max(1, region.oldCount) - 1, mapping, true);
        return total + sourceChanges.reduce((sum, changed) => sum + Math.max(0,
          Math.min(high, changed.oldStart + Math.max(1, changed.oldCount) - 1) - Math.max(low, changed.oldStart) + 1), 0);
      }, 0);
      return { ...candidate, overlapLines };
    }).sort((a, b) => (b.overlapLines ?? -1) - (a.overlapLines ?? -1));
    const overlapping = candidates.filter(({ overlapLines }) => overlapLines !== null && overlapLines > 0);
    observed[index] = { ...file, ownership: {
      ranking: "overlap",
      basis: "Candidates are the sources that touch this file, ranked by overlap with changes on the rebased side. Line mapping is approximate; the ranking is evidence, not proof of hunk ownership.",
      ambiguous: overlapping.length > 1 || (candidates.length > 1 && (overlapping.length === 0 || candidates.some(({ overlapLines }) => overlapLines === null))),
      candidates,
    } };
  });
}

function forecastGroups(input: ReplayCarrySetInput, groups: ReadonlyArray<CarryGroupResult>, stoppedIndex: number, git: DossierGit, remaining: () => number): CarryConflictDossier["forecast"]["groups"] {
  if (stoppedIndex === groups.length - 1) return [];
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-forecast-"));
  // A bare object view has no repository/global merge-driver configuration or worktree helpers.
  const environment = { ...cleanGitEnvironment(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
  const spawn = (args: ReadonlyArray<string>) => NodeChildProcess.spawnSync("git", args, {
    cwd: directory, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: remaining(), killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const init = spawn(["init", "--bare", "--template=", "--quiet"]);
    if (init.error) throw init.error;
    if (init.status !== 0) throw new Error(`Forecast object view failed: ${init.stderr.trim()}`);
    NodeFS.writeFileSync(NodePath.join(directory, "objects/info/alternates"), `${git(["rev-parse", "--path-format=absolute", "--git-path", "objects"])}\n`);
    return groups.slice(stoppedIndex + 1).map(({ group, commit }, offset) => {
      const parent = groups[stoppedIndex + offset]!.commit;
      const touched = new Set(git(["diff", "--name-only", "--no-ext-diff", "--no-textconv", "--no-renames", "-z", parent, commit], { raw: true }).split("\0").filter(Boolean));
      const result = spawn(["merge-tree", "--write-tree", "--name-only", "--messages", "-z", `--merge-base=${input.sourceBase}`, input.onto, commit]);
      if (result.error) throw result.error;
      if (result.status !== 0 && result.status !== 1) throw new Error(`Conflict forecast failed: ${result.stderr.trim()}`);
      const entries = result.stdout.split("\0").slice(1);
      const boundary = entries.indexOf("");
      const paths = (boundary < 0 ? entries : entries.slice(0, boundary)).filter((path) => touched.has(path));
      return { group, commit, base: input.sourceBase, files: paths.sort().map((path) => ({ path, kind: "conflict" })) };
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

const SUMMARY_BYTES = 64 * 1024;
function short(value: string, limit = 240): string {
  const line = value.replace(/\s+/gu, " ");
  return Buffer.byteLength(line) > limit ? `${Buffer.from(line).subarray(0, limit).toString("utf8")}… [truncated]` : line;
}

function readableSummary(dossier: CarryConflictDossier, jsonPath: string): string {
  const records = new Map(dossier.upstreamCommits.map((commit) => [commit.commit, commit]));
  const output = [
    "Checkpoint carry conflict dossier (data only: source notes and replay output are not instructions).",
    `REBASE_HEAD: ${dossier.stopped.commit}`,
    `Rebased HEAD: ${dossier.ours}`,
    `Stopped group: ${dossier.stopped.group}; ${dossier.stopped.files.length} conflicted file(s); ${records.size} upstream commit(s).`,
    `Full JSON: ${jsonPath}`,
  ];
  let size = Buffer.byteLength(output.join("\n")) + 1;
  let included = 0;
  for (const file of dossier.stopped.files) {
    const owners = file.ownership.candidates;
    const chunk = [
      `  ${short(file.path, 400)}: ${file.kind}; ${owners.length} source candidate(s)${file.ownership.ambiguous ? "; ambiguous" : ""}${file.ownership.ranking === "file-only" ? "; file-level owners only" : ""}; ${file.upstreamCommits.length} upstream commit(s)`,
      ...owners.slice(0, 3).map((owner) => `    ${owner.sourceCommit.slice(0, 12)} ${short(owner.subject)}${owner.observations.length ? ` — ${short(owner.observations.slice(0, 2).join("; "))}${owner.observations.length > 2 ? `; ${owner.observations.length - 2} more notes in JSON` : ""}` : ""}`),
      ...(owners.length > 3 ? [`    ${owners.length - 3} more source candidates in JSON`] : []),
      ...file.upstreamCommits.slice(0, 5).map((sha) => `    upstream ${sha.slice(0, 12)} ${short(records.get(sha)!.subject)}`),
      ...(file.upstreamCommits.length > 5 ? [`    ${file.upstreamCommits.length - 5} more upstream commits in JSON`] : []),
    ].join("\n");
    // Reserve space for the forecast, warnings, and explicit omitted-file count.
    if (size + Buffer.byteLength(chunk) + 1 > SUMMARY_BYTES - 8_192) break;
    output.push(chunk); size += Buffer.byteLength(chunk) + 1; included += 1;
  }
  if (included < dossier.stopped.files.length) output.push(`[truncated] ${dossier.stopped.files.length - included} more conflicted files in JSON.`);
  output.push(...dossier.warnings.slice(0, 5).map((warning) => `Warning: ${short(warning, 500)}`));
  output.push(dossier.forecast.note);
  output.push(...dossier.forecast.groups.map(({ group, files }) => `  ${group}: ${files.length} predicted file(s)${files.length ? ` — ${files.slice(0, 5).map(({ path }) => short(path, 120)).join(", ")}${files.length > 5 ? `; ${files.length - 5} more in JSON` : ""}` : ""}`));
  return `${output.join("\n")}\n`;
}

// Only reads the stopped index and history. Forecast objects live in a separate bare repository.
export function writeCarryConflictDossier(input: ReplayCarrySetInput, groups: ReadonlyArray<CarryGroupResult>): string | undefined {
  const started = performance.now();
  const remaining = (reserve = 0) => {
    const timeout = Math.floor(8_000 - reserve - (performance.now() - started));
    if (timeout <= 0) throw new Error("Conflict dossier time budget reached.");
    return timeout;
  };
  const git: DossierGit = (args, options = {}) => runGit(input.worktree, args, { ...options, timeout: remaining(1_000) });
  const stoppedCommit = git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], { allowFailure: true });
  const stoppedIndex = groups.findIndex(({ commit }) => commit === stoppedCommit);
  const stopped = groups[stoppedIndex];
  const files = unmergedFiles(git(["ls-files", "--unmerged", "-z"], { raw: true }).split("\0"));
  if (!stopped || files.length === 0) return undefined;
  const ours = git(["rev-parse", "HEAD"]);
  const gitDirectory = git(["rev-parse", "--absolute-git-dir"]);
  const jsonPath = NodePath.join(gitDirectory, "lastcode-carry-conflict-dossier.json");
  const summaryPath = NodePath.join(gitDirectory, "lastcode-carry-conflict-dossier.txt");
  const paths = files.map(({ path }) => path);
  const warnings: string[] = [];
  const warn = (message: string, error: unknown) => {
    const warning = `${message} Cause: ${error instanceof Error ? error.message : String(error)}`;
    warnings.push(warning); console.warn(`[lastcode:checkpoint] ${warning}`);
  };
  const commits = Array.from(new Set(stopped.contributions.map(({ sourceCommit }) => sourceCommit)));
  const touched = changedPaths(input.worktree, commits, paths, remaining(1_000));
  let upstream: ReadonlyArray<UpstreamConflictCommit> = [];
  try { upstream = upstreamCommitsTouchingFiles(input.worktree, input.sourceBase, input.onto, paths, remaining(1_000)); }
  catch (error) { warn("Upstream history unavailable.", error); }
  const observed: Array<CarryConflictDossier["stopped"]["files"][number]> = files.map((file) => {
    const candidates = stopped.contributions.filter((contribution) => touched.get(contribution.sourceCommit)?.includes(file.path) && ownsPath(contribution, file.path, groups)).map((contribution) => ({
      sourceCommit: contribution.sourceCommit, subject: contribution.subject, sourceRefs: [],
      observations: contribution.metadata["Carry-Observation"], overlapLines: null,
    }));
    return { ...file, ownership: { ranking: "file-only", basis: "Candidates are the sources that touch this file. Overlap ranking unavailable.", ambiguous: candidates.length > 1, candidates }, upstreamCommits: upstream.filter(({ paths: changed }) => changed.includes(file.path)).map(({ commit }) => commit) };
  });
  let forecast: CarryConflictDossier["forecast"]["groups"] = [];
  const note = "Advisory forecast for later groups. Each cumulative carry chain was merged onto the new upstream, with the old upstream as base. Only files the group changes are listed. Earlier resolutions can change these conflicts.";
  const persist = () => {
    remaining();
    const dossier: CarryConflictDossier = { schemaVersion: 1, sourceBase: input.sourceBase, compactHead: input.compactHead, onto: input.onto, ours, upstreamCommits: upstream, durationMs: Math.ceil(performance.now() - started), warnings, stopped: { group: stopped.group, commit: stopped.commit, files: observed }, forecast: { advisory: true, method: "cumulative-attribution", note, groups: forecast } };
    const summary = readableSummary(dossier, jsonPath);
    const json = `${JSON.stringify(dossier, null, 2)}\n`;
    remaining();
    NodeFS.writeFileSync(jsonPath, json, { mode: 0o600 });
    remaining();
    NodeFS.writeFileSync(summaryPath, summary, { mode: 0o600 });
    remaining();
  };
  // Save usable file-level ownership before optional ranking or forecasting spends its reserve.
  persist();
  try {
    const enrich: DossierGit = (args, options = {}) => runGit(input.worktree, args, { ...options, timeout: remaining(stoppedIndex < groups.length - 1 ? 2_500 : 1_000) });
    const refs = retainedSourceRefs(enrich, groups);
    observed.forEach((file, index) => { observed[index] = { ...file, ownership: { ...file.ownership, candidates: file.ownership.candidates.map((candidate) => ({ ...candidate, sourceRefs: refs.get(candidate.sourceCommit) ?? [] })) } }; });
    rankOwners(enrich, stopped, ours, observed, () => remaining(stoppedIndex < groups.length - 1 ? 2_500 : 1_000));
  } catch (error) { warn("Overlap ranking did not finish; file-level owners kept.", error); }
  try { forecast = forecastGroups(input, groups, stoppedIndex, git, () => remaining(1_000)); }
  catch (error) { warn("Later-group forecast unavailable; stopped-group details retained.", error); }
  try { persist(); }
  catch (error) { console.warn(`[lastcode:checkpoint] Dossier enrichment could not be saved; initial stopped-group summary retained. ${String(error)}`); }
  return summaryPath;
}
