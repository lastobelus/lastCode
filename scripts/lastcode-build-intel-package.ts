#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off -- Host-side GitHub workflow orchestration.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { acquirePortableLock } from "./lastcode-lock.mjs";

const DEFAULT_REPOSITORY = "lastobelus/lastCode";
const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "lastcode/main";
const WORKFLOW_FILE = "lastcode-intel-artifact.yml";
const REQUEST_SCHEMA_VERSION = 1;
const GH_TIMEOUT_MS = 30_000;
const REGISTRATION_TIMEOUT_MS = 2 * 60_000;
const REGISTRATION_POLL_MS = 5_000;
const RUN_TIMEOUT_MS = 2 * 60 * 60_000;
const RUN_POLL_MS = 30_000;

const installableTagPattern =
  /^lastcode\/(?:checkpoint|revision)\/v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+(?:\.[0-9]+)?$/u;
const fullCommitPattern = /^[0-9a-f]{40}$/u;

export interface BuildRequest {
  readonly schemaVersion: 1;
  readonly installableTag: string;
  readonly installableCommit: string;
  readonly requestToken: string;
  readonly selectedAt: string;
  readonly dispatchAttemptedAt: string | null;
  readonly workflowRunId: number | null;
}

export interface WorkflowRun {
  readonly databaseId: number;
  readonly displayTitle: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly headSha: string;
  readonly createdAt: string;
}

interface IntelRelease {
  readonly tagName: string;
  readonly url: string;
  readonly isDraft: boolean;
  readonly isImmutable: boolean;
  readonly isPrerelease: boolean;
  readonly assets: ReadonlyArray<{ readonly name: string }>;
}

export interface BuildIntelDependencies {
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly verifyWorkflow: () => void;
  readonly dispatchWorkflow: (request: BuildRequest) => void;
  readonly listWorkflowRuns: () => ReadonlyArray<WorkflowRun>;
  readonly readWorkflowRun: (runId: number) => WorkflowRun;
  readonly readRelease: (tag: string) => IntelRelease;
  readonly readRequest: () => BuildRequest;
  readonly writeRequest: (request: BuildRequest) => void;
  readonly removeRequest: (requestToken: string) => void;
  readonly withRequestLock: <T>(operation: () => T) => T;
  readonly log: (message: string) => void;
  readonly registrationTimeoutMs: number;
  readonly registrationPollMs: number;
  readonly runTimeoutMs: number;
  readonly runPollMs: number;
}

export type BuildIntelResult = {
  readonly tag: string;
  readonly commit: string;
  readonly requestToken: string;
  readonly runId: number;
  readonly runUrl: string;
  readonly workflowCommit: string;
  readonly releaseUrl: string;
  readonly assets: ReadonlyArray<string>;
};

function fail(message: string): never {
  throw new Error(message);
}

function runCommand(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(result.stderr.trim() || `${command} ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function runGhJson<T>(args: ReadonlyArray<string>): T {
  return JSON.parse(runCommand("gh", args)) as T;
}

export function validateInstallableTag(tag: string): string {
  if (!installableTagPattern.test(tag)) {
    fail("Expected an exact lastcode/checkpoint/... or lastcode/revision/... nightly tag.");
  }
  return tag;
}

export function resolveRemoteInstallableTag(
  tag: string,
  remote = DEFAULT_REMOTE,
): { readonly tag: string; readonly commit: string } {
  const validatedTag = validateInstallableTag(tag);
  const tagRef = `refs/tags/${validatedTag}`;
  const peeledRef = `${tagRef}^{}`;
  const output = runCommand("git", ["ls-remote", "--tags", remote, tagRef, peeledRef]);
  return parseRemoteInstallableRefs(validatedTag, remote, output);
}

export function parseRemoteInstallableRefs(
  tag: string,
  remote: string,
  output: string,
): { readonly tag: string; readonly commit: string } {
  const validatedTag = validateInstallableTag(tag);
  const tagRef = `refs/tags/${validatedTag}`;
  const peeledRef = `${tagRef}^{}`;
  const lines = output.split("\n").filter((line) => line.length > 0);
  const refs = new Map(
    lines.map((line) => {
      const [sha, ref, ...rest] = line.split("\t");
      if (!sha || !ref || rest.length > 0 || !fullCommitPattern.test(sha)) {
        fail(`Remote returned invalid metadata for ${validatedTag}.`);
      }
      return [ref, sha] as const;
    }),
  );
  const commit = refs.get(peeledRef) ?? refs.get(tagRef);
  if (!commit) fail(`Remote ${remote} does not advertise ${validatedTag}.`);
  return { tag: validatedTag, commit };
}

export function workflowRunName(request: Pick<BuildRequest, "installableTag" | "requestToken">) {
  return `Build Intel package · ${request.installableTag} · ${request.requestToken}`;
}

export function findCorrelatedRun(
  request: Pick<BuildRequest, "installableTag" | "requestToken">,
  runs: ReadonlyArray<WorkflowRun>,
): WorkflowRun | null {
  const expectedTitle = workflowRunName(request);
  const matches = runs.filter(({ displayTitle }) => displayTitle === expectedTitle);
  if (matches.length > 1) {
    fail(`More than one workflow run carries request token ${request.requestToken}.`);
  }
  return matches[0] ?? null;
}

function validateRequest(value: unknown): BuildRequest {
  if (typeof value !== "object" || value === null) fail("Intel build selection is invalid.");
  const request = value as Partial<BuildRequest>;
  if (
    request.schemaVersion !== REQUEST_SCHEMA_VERSION ||
    typeof request.installableTag !== "string" ||
    typeof request.installableCommit !== "string" ||
    typeof request.requestToken !== "string" ||
    typeof request.selectedAt !== "string" ||
    (request.dispatchAttemptedAt !== null && typeof request.dispatchAttemptedAt !== "string") ||
    (request.workflowRunId !== null &&
      (typeof request.workflowRunId !== "number" ||
        !Number.isSafeInteger(request.workflowRunId) ||
        request.workflowRunId <= 0))
  ) {
    fail("Intel build selection is invalid.");
  }
  validateInstallableTag(request.installableTag);
  if (!fullCommitPattern.test(request.installableCommit)) {
    fail("Intel build selection has an invalid commit.");
  }
  if (!/^intel-[0-9a-f-]{36}$/u.test(request.requestToken)) {
    fail("Intel build selection has an invalid request token.");
  }
  return request as BuildRequest;
}

function requestPath(): string {
  return NodePath.resolve(
    runCommand("git", ["rev-parse", "--git-path", "lastcode-actions/build-intel-package.json"]),
  );
}

function writeRequestFile(request: BuildRequest): void {
  const path = requestPath();
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporaryPath, path);
}

function readRequestFile(): BuildRequest {
  const path = requestPath();
  let contents: string;
  try {
    contents = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(
        "No Intel build is selected. Run 'pnpm lastcode:intel-build select --tag <exact-tag>' first.",
      );
    }
    throw error;
  }
  return validateRequest(JSON.parse(contents) as unknown);
}

function removeRequestFile(requestToken: string): void {
  const path = requestPath();
  if (!NodeFS.existsSync(path)) return;
  const current = readRequestFile();
  if (current.requestToken === requestToken) NodeFS.rmSync(path);
}

function defaultDependencies(): BuildIntelDependencies {
  const repository = process.env.LASTCODE_GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    verifyWorkflow: () => {
      const workflow = runGhJson<{ readonly path?: string; readonly state?: string }>([
        "api",
        `repos/${repository}/actions/workflows/${WORKFLOW_FILE}`,
      ]);
      if (workflow.path !== `.github/workflows/${WORKFLOW_FILE}` || workflow.state !== "active") {
        fail(`GitHub workflow ${WORKFLOW_FILE} is not active on the repository default branch.`);
      }
    },
    dispatchWorkflow: (request) => {
      runCommand("gh", [
        "workflow",
        "run",
        WORKFLOW_FILE,
        "--repo",
        repository,
        "--ref",
        DEFAULT_BRANCH,
        "--field",
        `installable_tag=${request.installableTag}`,
        "--field",
        `installable_commit=${request.installableCommit}`,
        "--field",
        `request_token=${request.requestToken}`,
      ]);
    },
    listWorkflowRuns: () =>
      runGhJson<ReadonlyArray<WorkflowRun>>([
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        WORKFLOW_FILE,
        "--event",
        "workflow_dispatch",
        "--limit",
        "100",
        "--json",
        "databaseId,displayTitle,status,conclusion,url,headSha,createdAt",
      ]),
    readWorkflowRun: (runId) =>
      runGhJson<WorkflowRun>([
        "run",
        "view",
        String(runId),
        "--repo",
        repository,
        "--json",
        "databaseId,displayTitle,status,conclusion,url,headSha,createdAt",
      ]),
    readRelease: (tag) =>
      runGhJson<IntelRelease>([
        "release",
        "view",
        tag,
        "--repo",
        repository,
        "--json",
        "assets,isDraft,isImmutable,isPrerelease,tagName,url",
      ]),
    readRequest: readRequestFile,
    writeRequest: writeRequestFile,
    removeRequest: removeRequestFile,
    withRequestLock: (operation) => {
      const path = requestPath();
      const release = acquirePortableLock(
        NodePath.dirname(path),
        "build-intel-package.lock",
        "Intel package dispatch",
      );
      try {
        return operation();
      } finally {
        release();
      }
    },
    log: (message) => console.log(message),
    registrationTimeoutMs: REGISTRATION_TIMEOUT_MS,
    registrationPollMs: REGISTRATION_POLL_MS,
    runTimeoutMs: RUN_TIMEOUT_MS,
    runPollMs: RUN_POLL_MS,
  };
}

export function selectIntelBuild(
  tag: string,
  input: {
    readonly resolveTag?: typeof resolveRemoteInstallableTag;
    readonly writeRequest?: (request: BuildRequest) => void;
    readonly nowIso?: () => string;
    readonly uuid?: () => string;
  } = {},
): BuildRequest {
  const target = (input.resolveTag ?? resolveRemoteInstallableTag)(tag);
  const request: BuildRequest = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    installableTag: target.tag,
    installableCommit: target.commit,
    requestToken: `intel-${(input.uuid ?? NodeCrypto.randomUUID)()}`,
    selectedAt: (input.nowIso ?? (() => new Date().toISOString()))(),
    dispatchAttemptedAt: null,
    workflowRunId: null,
  };
  (input.writeRequest ?? writeRequestFile)(request);
  return request;
}

async function waitForRegistration(
  request: BuildRequest,
  dependencies: BuildIntelDependencies,
): Promise<WorkflowRun> {
  const deadline = dependencies.now() + dependencies.registrationTimeoutMs;
  while (true) {
    const run = findCorrelatedRun(request, dependencies.listWorkflowRuns());
    if (run) return run;
    if (dependencies.now() >= deadline) {
      fail(
        `GitHub did not register workflow request ${request.requestToken} within ${dependencies.registrationTimeoutMs}ms.`,
      );
    }
    await dependencies.sleep(dependencies.registrationPollMs);
  }
}

async function waitForCompletion(
  initialRun: WorkflowRun,
  dependencies: BuildIntelDependencies,
): Promise<WorkflowRun> {
  const deadline = dependencies.now() + dependencies.runTimeoutMs;
  let run = initialRun;
  let previousStatus = "";
  while (run.status !== "completed") {
    if (run.status !== previousStatus) {
      dependencies.log(`[build-intel] Workflow ${run.databaseId} is ${run.status}: ${run.url}`);
      previousStatus = run.status;
    }
    if (dependencies.now() >= deadline) {
      fail(
        `Intel workflow ${run.databaseId} did not finish within the configured timeout: ${run.url}`,
      );
    }
    await dependencies.sleep(dependencies.runPollMs);
    run = dependencies.readWorkflowRun(run.databaseId);
  }
  return run;
}

export async function runSelectedIntelBuild(
  dependencies: BuildIntelDependencies = defaultDependencies(),
): Promise<BuildIntelResult> {
  dependencies.verifyWorkflow();

  let { request, run } = dependencies.withRequestLock(() => {
    let lockedRequest = dependencies.readRequest();
    const lockedRun =
      lockedRequest.workflowRunId === null
        ? findCorrelatedRun(lockedRequest, dependencies.listWorkflowRuns())
        : dependencies.readWorkflowRun(lockedRequest.workflowRunId);
    if (lockedRun && lockedRun.displayTitle !== workflowRunName(lockedRequest)) {
      fail(
        `Stored workflow run ${lockedRun.databaseId} does not match request ${lockedRequest.requestToken}.`,
      );
    }
    if (!lockedRun && lockedRequest.dispatchAttemptedAt === null) {
      lockedRequest = { ...lockedRequest, dispatchAttemptedAt: dependencies.nowIso() };
      dependencies.writeRequest(lockedRequest);
      try {
        dependencies.dispatchWorkflow(lockedRequest);
      } catch (error) {
        dependencies.log(
          `[build-intel] Dispatch returned an error; waiting for request-token registration before deciding whether it was accepted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { request: lockedRequest, run: lockedRun };
  });
  run ??= await waitForRegistration(request, dependencies);
  if (request.workflowRunId === null) {
    dependencies.withRequestLock(() => {
      const current = dependencies.readRequest();
      if (current.requestToken !== request.requestToken) return;
      request = current;
      if (request.workflowRunId === null) {
        request = { ...request, workflowRunId: run.databaseId };
        dependencies.writeRequest(request);
      }
    });
  }
  dependencies.log(
    `[build-intel] Registered ${workflowRunName(request)} as run ${run.databaseId}: ${run.url}`,
  );

  const completed = await waitForCompletion(run, dependencies);
  if (completed.conclusion !== "success") {
    dependencies.removeRequest(request.requestToken);
    fail(
      `Intel workflow ${completed.databaseId} ended with ${completed.conclusion ?? "no conclusion"}: ${completed.url}`,
    );
  }

  const release = dependencies.readRelease(request.installableTag);
  if (
    release.tagName !== request.installableTag ||
    release.isDraft ||
    !release.isImmutable ||
    !release.isPrerelease ||
    release.assets.length === 0
  ) {
    fail(
      `Intel workflow succeeded but ${request.installableTag} is not a complete immutable prerelease.`,
    );
  }
  dependencies.removeRequest(request.requestToken);
  return {
    tag: request.installableTag,
    commit: request.installableCommit,
    requestToken: request.requestToken,
    runId: completed.databaseId,
    runUrl: completed.url,
    workflowCommit: completed.headSha,
    releaseUrl: release.url,
    assets: release.assets.map(({ name }) => name).sort(),
  };
}

export function parseIntelBuildOptions(
  argv: ReadonlyArray<string>,
): { readonly command: "select"; readonly tag: string } | { readonly command: "run" } {
  const [command, ...rest] = argv;
  if (command === "run" && rest.length === 0) return { command };
  if (command === "select") {
    const tagIndex = rest.indexOf("--tag");
    const tag = tagIndex >= 0 ? rest[tagIndex + 1] : undefined;
    if (tag && rest.length === 2 && tagIndex === 0) return { command, tag };
  }
  fail(
    "Usage: lastcode-build-intel-package.ts select --tag <exact-tag> | lastcode-build-intel-package.ts run",
  );
}

async function main(): Promise<void> {
  const options = parseIntelBuildOptions(process.argv.slice(2));
  if (options.command === "select") {
    const request = selectIntelBuild(options.tag);
    console.log(
      `[build-intel] Selected ${request.installableTag} at ${request.installableCommit}.\n` +
        `[build-intel] Request token: ${request.requestToken}. Run the Build Intel package Project Action.`,
    );
    return;
  }
  const result = await runSelectedIntelBuild();
  console.log(`[build-intel] Result ${JSON.stringify(result)}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[build-intel] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
