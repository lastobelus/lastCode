// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - isolated CI subprocess driver.
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { shardedTestFiles } from "./lib/sharded-tests.ts";

NodeAssert.equal(process.version, "v24.13.1", "Pilot driver requires checkpoint Node v24.13.1");

const root = NodePath.resolve(import.meta.dirname, "..");
const server = NodePath.join(root, "apps/server");
const cohort = process.argv[2];
if (!["baseline", "1", "2"].includes(cohort ?? "")) throw new Error("Expected baseline, 1 or 2");
const output = NodePath.resolve(process.argv[3]!);
NodeFS.mkdirSync(output, { recursive: true });
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=no"))
  throw new Error("Candidate must be clean");
const digest = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const candidate = git("rev-parse", "HEAD");
if (candidate !== process.env.GITHUB_SHA)
  throw new Error("Checkout differs from workflow candidate");
const fingerprint = {
  candidate,
  tree: git("rev-parse", "HEAD^{tree}"),
  lock: digest(NodeFS.readFileSync(NodePath.join(root, "pnpm-lock.yaml"))),
  node: process.version,
  vp: NodeChildProcess.execFileSync("vp", ["--version"], { encoding: "utf8" }).trim(),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CI driver has no Effect runtime.
  platform: NodeOS.platform(),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CI driver has no Effect runtime.
  arch: NodeOS.arch(),
  image: process.env.ImageOS,
  imageVersion: process.env.ImageVersion,
  cpus: NodeOS.cpus().length,
  cpu: NodeOS.cpus()[0]?.model,
  memoryGiB: Math.round(NodeOS.totalmem() / 1024 ** 3),
};
const relative = (files: string[]) => files.map((file) => NodePath.relative(server, file)).sort();
const discovery = relative(await shardedTestFiles(server, "1/1"));
const shard = cohort === "baseline" ? [] : ["--shard", `${cohort}/2`];
const selected =
  cohort === "baseline" ? discovery : relative(await shardedTestFiles(server, `${cohort}/2`));
NodeFS.writeFileSync(
  NodePath.join(output, "discovery.json"),
  JSON.stringify({ fingerprint, discovery, selected }, null, 2),
);
const reportPath = NodePath.join(output, "tests.json");
const runtimePath = NodePath.join(output, "runtime.json");
const startedAt = Date.now();
const started = performance.now();
const result = NodeChildProcess.spawnSync(
  "vp",
  [
    "test",
    "run",
    "--cache=false",
    "--fsModuleCache=false",
    "--fileParallelism=false",
    ...shard,
    "--reporter=default",
    "--reporter=json",
    `--reporter=${NodeURL.fileURLToPath(import.meta.resolve("./lib/server-test-pilot-runtime-reporter.mjs"))}`,
    `--outputFile.json=${reportPath}`,
  ],
  {
    cwd: server,
    stdio: "inherit",
    env: {
      ...process.env,
      VP_REMOTE_CACHE: "off",
      VP_REMOTE_CACHE_URL: "",
      VP_NODE_VERSION: "24.13.1",
      T3CODE_SERVER_PILOT_RUNTIME_PATH: runtimePath,
      T3CODE_TRANSFER_BUDGET_REPORT_PATH: NodePath.join(output, "transfer.md"),
      T3CODE_TRANSFER_BUDGET_RESULT_PATH: NodePath.join(output, "transfer.json"),
    },
  },
);
const durationMs = performance.now() - started;
const endedAt = Date.now();
const report = NodeFS.existsSync(reportPath)
  ? JSON.parse(NodeFS.readFileSync(reportPath, "utf8"))
  : null;
const testRuntime = NodeFS.existsSync(runtimePath)
  ? JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"))
  : null;
const receipt = {
  cohort,
  fingerprint: { ...fingerprint, testNode: testRuntime?.node },
  discovery,
  selected,
  machine: digest(NodeFS.readFileSync("/proc/sys/kernel/random/boot_id")),
  exitCode: result.status,
  signal: result.signal,
  success:
    report?.success === true && report.numFailedTestSuites === 0 && report.numFailedTests === 0,
  executed: relative((report?.testResults ?? []).map((suite: { name: string }) => suite.name)),
  transferProduced: ["transfer.md", "transfer.json"].every((file) =>
    NodeFS.existsSync(NodePath.join(output, file)),
  ),
  startedAt,
  endedAt,
  durationMs,
};
NodeFS.writeFileSync(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
process.exitCode = result.status ?? 1;
