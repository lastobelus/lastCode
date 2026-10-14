// @effect-diagnostics nodeBuiltinImport:off -- Host-side admission coordinates local subprocesses and lease files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";

import {
  DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  LastCodeLocalCiSettings,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import { PortableLockContentionError } from "../lastcode-lock.mjs";
import { acquireLocalCiAdmissionLock } from "./lastcode-ci-admission-lock.ts";
import {
  getCurrentProcessStartIdentity,
  isProcessIdentityRunning,
  isProcessRunning,
  readProcessIdentities,
} from "./lastcode-ci-process-identity.ts";

const decodePolicy = Schema.decodeUnknownSync(LastCodeLocalCiSettings);
const LEASE_SUFFIX = ".lease.json";
const WAITER_SUFFIX = ".waiter.json";
const RETRY_INTERVAL_MS = 500;

type Lease = {
  readonly pid: number;
  readonly startIdentity: string;
  childPid: number | null;
  childStartIdentity: string | null;
  readonly token: string;
  readonly maxConcurrentRuns: number;
  readonly repoRoot: string;
};

type Waiter = {
  readonly pid: number;
  readonly startIdentity: string;
  readonly token: string;
  readonly order: number;
};

function hasErrorCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the CI fragment only; diagnostics never include other persisted settings. */
export async function readLocalCiPolicy(env = NodeProcess.env) {
  const settingsPath =
    env.T3CODE_LOCAL_CI_SETTINGS_PATH ??
    NodePath.join(
      env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".lastcode"),
      "userdata",
      "settings.json",
    );
  let content: string;
  try {
    content = await NodeFSP.readFile(settingsPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { ...DEFAULT_LASTCODE_LOCAL_CI_SETTINGS };
    throw new Error("Unable to read local CI settings. Check the settings file permissions.", {
      cause: error,
    });
  }

  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    throw new Error("Invalid local CI settings: the settings file must contain valid JSON.");
  }
  if (!isRecord(settings)) {
    throw new Error("Invalid local CI settings: the settings file must contain an object.");
  }
  if (settings.lastcodeLocalCi === undefined) return { ...DEFAULT_LASTCODE_LOCAL_CI_SETTINGS };
  try {
    return decodePolicy(settings.lastcodeLocalCi);
  } catch {
    throw new Error(
      "Invalid local CI settings: lastcodeLocalCi must use quickCiMode auto/local/github, maxConcurrentRuns 1–4, packageConcurrency 1–8, compilerThreads 1–16, and a boolean backgroundPriority.",
    );
  }
}

function hasLivingChild(
  lease: Pick<Lease, "childPid" | "childStartIdentity">,
  identities = readProcessIdentities(lease.childPid === null ? [] : [lease.childPid]),
) {
  if (lease.childPid === null) return false;
  if (NodeProcess.platform === "win32") {
    return isProcessIdentityRunning(lease.childPid, lease.childStartIdentity, identities);
  }
  if (!isProcessRunning(-lease.childPid)) return false;
  const leader = identities.get(lease.childPid);
  // A leaderless group can still contain owned descendants. Only a positively
  // identified replacement group leader proves that this group ID was reused.
  return (
    lease.childStartIdentity === null ||
    leader === undefined ||
    leader.group !== lease.childPid ||
    leader.startIdentity === lease.childStartIdentity
  );
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStartIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A child may lack a captured identity; an identity must never lack its child PID. */
function isChildIdentity(pid: unknown, identity: unknown) {
  if (pid === null) return identity === null;
  return isPositivePid(pid) && (identity === null || isStartIdentity(identity));
}

function readLeases(directory: string) {
  const leases: Lease[] = [];
  for (const name of NodeFS.readdirSync(directory)) {
    if (!name.endsWith(LEASE_SUFFIX)) continue;
    const path = NodePath.join(directory, name);
    let content: string;
    try {
      content = NodeFS.readFileSync(path, "utf8");
    } catch (error) {
      // A release can remove its unique file while admission holds the mutex.
      if (hasErrorCode(error, "ENOENT")) continue;
      throw new Error(
        "Unable to read a local CI lease. Admission has stopped to avoid exceeding the budget.",
        { cause: error },
      );
    }
    let lease: unknown;
    try {
      lease = JSON.parse(content);
    } catch {
      throw new Error(
        "Invalid local CI lease JSON. Admission has stopped to avoid exceeding the budget.",
      );
    }
    if (
      !isRecord(lease) ||
      !isPositivePid(lease.pid) ||
      !isStartIdentity(lease.startIdentity) ||
      !isChildIdentity(lease.childPid, lease.childStartIdentity) ||
      typeof lease.token !== "string" ||
      `${lease.token}${LEASE_SUFFIX}` !== name ||
      typeof lease.maxConcurrentRuns !== "number" ||
      !Number.isSafeInteger(lease.maxConcurrentRuns) ||
      lease.maxConcurrentRuns < 1 ||
      lease.maxConcurrentRuns > 4 ||
      typeof lease.repoRoot !== "string"
    ) {
      throw new Error(
        "Invalid local CI lease. Admission has stopped to avoid exceeding the budget.",
      );
    }
    leases.push({
      pid: lease.pid,
      startIdentity: lease.startIdentity,
      childPid: lease.childPid as number | null,
      childStartIdentity: lease.childStartIdentity as string | null,
      token: lease.token,
      maxConcurrentRuns: lease.maxConcurrentRuns,
      repoRoot: lease.repoRoot,
    });
  }
  return leases;
}

function readWaiters(directory: string) {
  const waiters: Waiter[] = [];
  for (const name of NodeFS.readdirSync(directory)) {
    if (!name.endsWith(WAITER_SUFFIX)) continue;
    const path = NodePath.join(directory, name);
    let content: string;
    try {
      content = NodeFS.readFileSync(path, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw new Error("Unable to read a local CI waiter. Admission has stopped.", { cause: error });
    }
    let waiter: unknown;
    try {
      waiter = JSON.parse(content);
    } catch {
      throw new Error("Invalid local CI waiter JSON. Admission has stopped.");
    }
    if (
      !isRecord(waiter) ||
      typeof waiter.pid !== "number" ||
      !Number.isSafeInteger(waiter.pid) ||
      waiter.pid <= 0 ||
      typeof waiter.startIdentity !== "string" ||
      waiter.startIdentity.length === 0 ||
      typeof waiter.token !== "string" ||
      `${waiter.token}${WAITER_SUFFIX}` !== name ||
      typeof waiter.order !== "number" ||
      !Number.isSafeInteger(waiter.order) ||
      waiter.order <= 0
    ) {
      throw new Error("Invalid local CI waiter. Admission has stopped.");
    }
    waiters.push({
      pid: waiter.pid,
      startIdentity: waiter.startIdentity,
      token: waiter.token,
      order: waiter.order,
    });
  }
  return waiters.sort(
    (left, right) => left.order - right.order || left.token.localeCompare(right.token),
  );
}

type BudgetOptions = {
  readonly policy: LastCodeLocalCiSettings;
  readonly repoRoot: string;
  readonly signal?: AbortSignal;
  readonly onWaiting?: (summary: string) => void;
  readonly directory?: string;
};

export type LocalCiBudgetLease = {
  readonly release: () => void;
  /** Records the exact detached child group on POSIX, or the child PID on Windows. */
  readonly recordChild: (pid: number | undefined) => void;
};

function writeRecord(path: string, record: Lease | Waiter) {
  // Publishing by rename means a crash can leave only an ignored temp file or
  // a complete lease. Updates also remain readable during another admission.
  const temporaryPath = `${path}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    NodeFS.renameSync(temporaryPath, path);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Holds one machine-wide CI slot. The caller must keep this process and its
 * lease alive until all of its CI subprocesses have ended, including cancellation.
 */
export async function acquireLocalCiBudget(options: BudgetOptions): Promise<LocalCiBudgetLease> {
  return acquireBudget(options, true);
}

/** Claims an immediately available slot without waiting or overtaking queued runs. */
export async function tryAcquireLocalCiBudget(
  options: BudgetOptions,
): Promise<LocalCiBudgetLease | undefined> {
  return acquireBudget(options, false);
}

function acquireBudget(options: BudgetOptions, waitForCapacity: true): Promise<LocalCiBudgetLease>;
function acquireBudget(
  options: BudgetOptions,
  waitForCapacity: false,
): Promise<LocalCiBudgetLease | undefined>;
async function acquireBudget(
  options: BudgetOptions,
  waitForCapacity: boolean,
): Promise<LocalCiBudgetLease | undefined> {
  const policy = decodePolicy(options.policy);
  const directory =
    options.directory ?? NodePath.join(NodeOS.homedir(), ".cache", "lastcode", "local-ci");
  const token = NodeCrypto.randomUUID();
  const leasePath = NodePath.join(directory, `${token}${LEASE_SUFFIX}`);
  const waiterPath = NodePath.join(directory, `${token}${WAITER_SUFFIX}`);
  let registered = false;
  const lease: Lease = {
    pid: NodeProcess.pid,
    startIdentity: getCurrentProcessStartIdentity(),
    childPid: null,
    childStartIdentity: null,
    token,
    maxConcurrentRuns: policy.maxConcurrentRuns,
    repoRoot: NodePath.resolve(options.repoRoot),
  };
  let previousSummary: string | undefined;
  const waiting = (summary: string) => {
    if (summary !== previousSummary) options.onWaiting?.(summary);
    previousSummary = summary;
  };

  try {
    for (;;) {
      options.signal?.throwIfAborted();
      let releaseMutex: (() => void) | undefined;
      try {
        releaseMutex = await acquireLocalCiAdmissionLock(directory);
      } catch (error) {
        if (!(error instanceof PortableLockContentionError)) throw error;
      }

      if (releaseMutex !== undefined) {
        try {
          options.signal?.throwIfAborted();
          const leases = readLeases(directory);
          const queued = readWaiters(directory);
          // One targeted OS query covers the small lease set and this queue.
          const identities = readProcessIdentities([
            ...leases.flatMap((owner) =>
              owner.childPid === null ? [owner.pid] : [owner.pid, owner.childPid],
            ),
            ...queued.map((waiter) => waiter.pid),
          ]);
          const active = leases.filter((owner) => {
            if (
              isProcessIdentityRunning(owner.pid, owner.startIdentity, identities) ||
              hasLivingChild(owner, identities)
            )
              return true;
            NodeFS.rmSync(NodePath.join(directory, `${owner.token}${LEASE_SUFFIX}`), {
              force: true,
            });
            return false;
          });
          const waiters = queued.filter((waiter) => {
            if (isProcessIdentityRunning(waiter.pid, waiter.startIdentity, identities)) return true;
            NodeFS.rmSync(NodePath.join(directory, `${waiter.token}${WAITER_SUFFIX}`), {
              force: true,
            });
            return false;
          });
          if (!registered) {
            const order = Math.max(0, ...waiters.map((waiter) => waiter.order)) + 1;
            if (!Number.isSafeInteger(order))
              throw new Error("The local CI queue order exceeded its supported range.");
            const waiter: Waiter = {
              pid: NodeProcess.pid,
              startIdentity: lease.startIdentity,
              token,
              order,
            };
            writeRecord(waiterPath, waiter);
            waiters.push(waiter);
            registered = true;
          }
          const limit = Math.min(
            policy.maxConcurrentRuns,
            ...active.map((owner) => owner.maxConcurrentRuns),
          );
          if (waiters[0]?.token === token && active.length < limit) {
            writeRecord(leasePath, lease);
            NodeFS.rmSync(waiterPath, { force: true });
            let released = false;
            return {
              release() {
                if (released) return;
                if (hasLivingChild(lease)) {
                  throw new Error(
                    "Cannot release local CI capacity while an owned check is still running.",
                  );
                }
                NodeFS.rmSync(leasePath, { force: true });
                released = true;
              },
              recordChild(pid) {
                if (released)
                  throw new Error("Cannot record a child after releasing the local CI budget.");
                if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) {
                  throw new Error("A local CI child PID must be a positive integer.");
                }
                if (lease.childPid !== null && lease.childPid !== pid && hasLivingChild(lease)) {
                  throw new Error(
                    "Cannot replace a local CI child while its owned check is still running.",
                  );
                }
                lease.childPid = pid ?? null;
                lease.childStartIdentity =
                  pid === undefined
                    ? null
                    : (readProcessIdentities([pid]).get(pid)?.startIdentity ?? null);
                writeRecord(leasePath, lease);
              },
            };
          }
          if (!waitForCapacity) return undefined;
          const position = waiters.findIndex((waiter) => waiter.token === token) + 1;
          waiting(
            `Waiting for local CI capacity (${active.length} active; limit ${limit}; queue position ${position}).`,
          );
        } finally {
          releaseMutex();
        }
      } else {
        if (!waitForCapacity) return undefined;
        waiting("Waiting for another local CI run to finish its admission update.");
      }
      await NodeTimersPromises.setTimeout(RETRY_INTERVAL_MS, undefined, { signal: options.signal });
    }
  } finally {
    // Each waiter has a unique token, so cancellation or an unavailable try can
    // unlink its own record without disturbing another queued run.
    NodeFS.rmSync(waiterPath, { force: true });
  }
}
