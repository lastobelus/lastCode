// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  advisoryRuntimeIdentity,
  cacheSummaryPaths,
  isolateAdvisoryCache,
  matchesTestPath,
} from "./lib/cached-tests.ts";
import { shardedTestFiles } from "./lib/sharded-tests.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const { values, positionals } = NodeUtil.parseArgs({
  args: process.argv[2] === "--" ? process.argv.slice(3) : process.argv.slice(2),
  allowPositionals: true,
  options: {
    "group-size": { type: "string", default: "1" },
    concurrency: { type: "string", default: "1" },
    shard: { type: "string" },
    report: { type: "string" },
    advisory: { type: "boolean", default: false },
    "verify-hits": { type: "string", default: "0" },
    uncached: { type: "string", multiple: true, default: [] },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "vp run test:cached [--group-size 1] [--concurrency 1] [--shard index/count] [--uncached file] [test files or directories]",
  );
  process.exit(0);
}
if (
  values.advisory &&
  (!values.report ||
    values.shard ||
    positionals.length === 0 ||
    positionals.length > 16 ||
    values.concurrency !== "1" ||
    values["group-size"] !== "1")
) {
  throw new Error(
    "Advisory mode requires --report, 1–16 explicit test files, and serial per-file execution",
  );
}
const groupSize = Number(values["group-size"]);
const concurrency = Number(values.concurrency);
const verifyHits = values.advisory
  ? Math.max(1, Number(values["verify-hits"]))
  : Number(values["verify-hits"]);
if (!Number.isSafeInteger(verifyHits) || verifyHits < 0)
  throw new Error("Invalid verification count");
if (![groupSize, concurrency].every((value) => Number.isSafeInteger(value) && value > 0)) {
  throw new Error("Group size and concurrency must be positive integers");
}
if (values.shard && positionals.length !== 1) {
  throw new Error("Sharding requires exactly one test project directory");
}
const candidates = values.shard
  ? (await shardedTestFiles(NodePath.resolve(positionals[0]!), values.shard)).map((file) =>
      NodePath.relative(root, file),
    )
  : NodeChildProcess.execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ).split("\0");
const filters = positionals.map((path) => NodePath.relative(root, NodePath.resolve(path)));
const isSelectable = (file: string) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
  !file.startsWith(".repos/") &&
  NodeFS.existsSync(NodePath.join(root, file)) &&
  matchesTestPath(file, filters);
if (values.shard) {
  const rejected = candidates.filter((file) => !isSelectable(file));
  if (rejected.length)
    throw new Error(`Discovered tests cannot be selected: ${rejected.join(", ")}`);
}
const files = [...new Set(candidates)].filter(isSelectable);
if (files.length === 0) {
  console.error("No test files matched");
  process.exit(values.shard ? 0 : 1);
}
if (
  values.advisory &&
  (files.length !== positionals.length ||
    filters.some((file) => !file.startsWith("apps/server/") || !files.includes(file)))
) {
  throw new Error("Advisory mode accepts explicit server test files only");
}
const cacheRoot = values.advisory
  ? NodePath.join(root, "node_modules/.vite/advisory-test-cache")
  : process.env.VITE_CACHE_PATH || NodePath.join(root, "node_modules/.vite/task-cache");
const lease = values.advisory ? isolateAdvisoryCache(cacheRoot) : undefined;
if (lease) process.on("exit", lease);
console.log(
  `Cached tests: ${files.length} files, ${groupSize} per task, concurrency ${concurrency}`,
);
const env = {
  ...process.env,
  ...(values.advisory
    ? { VITE_CACHE_PATH: cacheRoot, VP_REMOTE_CACHE: "off", VP_REMOTE_CACHE_URL: "" }
    : {}),
  T3_CACHED_TESTS: JSON.stringify({
    files,
    groupSize,
    uncached: [
      ...values.uncached.map((file) => NodePath.relative(root, NodePath.resolve(file))),
      ...(values.advisory ? ["apps/server/integration/transferBudgetV2.integration.test.ts"] : []),
    ],
    ...(values.advisory ? { advisoryRuntime: advisoryRuntimeIdentity() } : {}),
  }),
};
const runTask = (args: Array<string>) =>
  NodeChildProcess.spawnSync(
    lease ? process.execPath : NodePath.join(root, "node_modules/.bin/vp"),
    lease
      ? [NodePath.join(root, "scripts/lib/cached-tests.ts"), cacheRoot, lease.token, ...args]
      : args,
    { cwd: root, env, stdio: "inherit" },
  );
const started = performance.now();
const candidate = values.advisory
  ? NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim()
  : undefined;
const result = runTask(["run", "--concurrency-limit", String(concurrency), "test-cache"]);
if (result.error) throw result.error;
const cacheRunMs = performance.now() - started;
process.exitCode = result.status ?? 1;
if (values.report || verifyHits > 0) {
  const summaryFiles = cacheSummaryPaths(cacheRoot).sort(
    (a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs,
  );
  if (values.advisory && summaryFiles.length !== 1) {
    throw new Error("Advisory run did not produce exactly one isolated cache summary");
  }
  const summary: {
    tasks: Array<{
      task_name: string;
      result: { CacheHit?: { source: string; saved_duration_ms: number } };
    }>;
  } = JSON.parse(NodeFS.readFileSync(summaryFiles[0]!, "utf8"));
  const rank = (task: string) =>
    NodeCrypto.createHash("sha256")
      .update(
        `${process.env.GITHUB_RUN_ID || "local"}:${process.env.GITHUB_RUN_ATTEMPT || "1"}:${task}`,
      )
      .digest("hex");
  const hits = summary.tasks.filter((task) => task.result.CacheHit);
  const verify = hits
    .toSorted((a, b) => rank(a.task_name).localeCompare(rank(b.task_name)))
    .slice(0, verifyHits);
  const verification: Array<{ task: string; exitCode: number; durationMs: number }> = [];
  if (result.status === 0) {
    for (const task of verify) {
      console.log(`Verifying cached result without cache: ${task.task_name}`);
      const start = performance.now();
      const audit = runTask(["run", "--no-cache", "--remote-cache", "off", task.task_name]);
      if (audit.error) throw audit.error;
      verification.push({
        task: task.task_name,
        exitCode: audit.status ?? 1,
        durationMs: performance.now() - start,
      });
      if (audit.status !== 0) process.exitCode = audit.status ?? 1;
    }
  }
  const report = {
    advisory: values.advisory,
    ...(values.advisory
      ? {
          runId: NodeCrypto.randomUUID(),
          candidate,
          dirty:
            NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
              cwd: root,
              encoding: "utf8",
            }).trim().length > 0,
          runtime: advisoryRuntimeIdentity(),
          uncached: JSON.parse(env.T3_CACHED_TESTS).uncached,
        }
      : {}),
    shard: values.shard,
    files,
    cacheRunMs,
    exitCode: process.exitCode ?? 0,
    summary,
    verification,
  };
  if (values.report) {
    NodeFS.mkdirSync(NodePath.dirname(values.report), { recursive: true });
    NodeFS.writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const remote = hits.filter((task) => task.result.CacheHit?.source === "Remote").length;
    const savedMs = hits.reduce(
      (total, task) => total + (task.result.CacheHit?.saved_duration_ms ?? 0),
      0,
    );
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Server test cache (${values.shard || "unsharded"})\n\n` +
        `${files.length} files selected; ${hits.length} hits (${remote} remote); ${(savedMs / 1000).toFixed(1)}s task runtime avoided; ${(cacheRunMs / 1000).toFixed(1)}s elapsed.\n\n` +
        `${verification.length} cached results re-executed without cache; ${verification.filter((audit) => audit.exitCode !== 0).length} verification failures.\n`,
    );
  }
}
