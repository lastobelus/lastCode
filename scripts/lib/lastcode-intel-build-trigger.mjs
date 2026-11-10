// LastCode managed module: intel-build-trigger
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const WORKFLOW = "lastcode-daily-intel-package.yml";

function runCommand(repoRoot, command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} failed.`);
  return result.stdout.trim();
}

/** Request hosted Intel work only after the local artifact has been verified. */
export function triggerIntelBuild({ home, repoRoot, tag, commit }, overrides = {}) {
  try {
    const configPath = NodePath.join(home, ".lastcode", "automation", "intel-build-trigger.json");
    let config;
    try {
      config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "not-configured" };
      throw error;
    }
    if (config?.schemaVersion !== 1 || typeof config.enabled !== "boolean") {
      throw new Error("Intel build trigger configuration is invalid.");
    }
    if (!config.enabled) return { status: "disabled" };
    if (
      typeof tag !== "string" ||
      tag.trim() !== tag ||
      !/^lastcode\/(?:checkpoint|revision)\/v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+(?:\.\d+)?$/u.test(
        tag,
      ) ||
      typeof commit !== "string" ||
      !/^[0-9a-f]{40}$/u.test(commit)
    ) {
      throw new Error("Intel build trigger requires an exact installable tag and full commit.");
    }
    const run = overrides.runCommand ?? runCommand;
    const tagRef = `refs/tags/${tag}`;
    const output = run(repoRoot, "git", ["ls-remote", "--tags", "origin", tagRef, `${tagRef}^{}`]);
    const refs = new Map(
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ref, ...rest] = line.split("\t");
          if (!sha || !ref || rest.length || !/^[0-9a-f]{40}$/u.test(sha)) {
            throw new Error("Published installable tag metadata is invalid.");
          }
          return [ref, sha];
        }),
    );
    const remoteCommit = refs.get(`${tagRef}^{}`) ?? refs.get(tagRef);
    if (remoteCommit !== commit) {
      throw new Error(`Published tag ${tag} does not match verified local commit ${commit}.`);
    }
    const repository = process.env.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode";
    const title = `Ensure Intel package · ${tag} · ${commit}`;
    const runs = JSON.parse(
      run(repoRoot, "gh", [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        WORKFLOW,
        "--limit",
        "100",
        "--json",
        "databaseId,displayTitle,status,url",
      ]),
    );
    if (!Array.isArray(runs)) throw new Error("Intel dispatcher run list is invalid.");
    const active = runs.find(
      (entry) => entry.displayTitle === title && entry.status !== "completed",
    );
    if (active) {
      if (
        !Number.isSafeInteger(active.databaseId) ||
        active.databaseId < 1 ||
        typeof active.url !== "string"
      ) {
        throw new Error("Intel dispatcher run metadata is invalid.");
      }
      return { status: "running", tag, commit, runId: active.databaseId, runUrl: active.url };
    }
    run(repoRoot, "gh", [
      "workflow",
      "run",
      WORKFLOW,
      "--repo",
      repository,
      "--ref",
      "lastcode/main",
      "--field",
      `installable_tag=${tag}`,
      "--field",
      `installable_commit=${commit}`,
    ]);
    return { status: "dispatched", tag, commit };
  } catch (error) {
    return {
      status: "failed",
      tag,
      commit,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
