// @effect-diagnostics nodeBuiltinImport:off -- These regressions exercise exact owned processes and temporary files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";

import { DEFAULT_LASTCODE_LOCAL_CI_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acquireLocalCiBudget,
  readLocalCiPolicy,
  tryAcquireLocalCiBudget,
} from "./lastcode-ci-budget.ts";
import { acquireLocalCiAdmissionLock } from "./lastcode-ci-admission-lock.ts";
import * as ProcessIdentity from "./lastcode-ci-process-identity.ts";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const directories: string[] = [];
const children: NodeChildProcess.ChildProcess[] = [];
const cleanups: Array<() => Promise<void>> = [];
const originalHome = NodeOS.homedir();

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      // Only terminate the exact fixture process captured by this test.
      child.kill();
      await closed;
    }),
  );
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { force: true, recursive: true });
  vi.restoreAllMocks();
  vi.mocked(NodeOS.homedir).mockReturnValue(originalHome);
});

function temporaryDirectory() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-budget-"));
  directories.push(root);
  return root;
}

function settingsFile(content: string, root = temporaryDirectory()) {
  const path = NodePath.join(root, "settings.json");
  NodeFS.writeFileSync(path, content);
  return path;
}

type WorkerMessage = {
  readonly type: string;
  readonly summary?: string;
  readonly acquired?: boolean;
  readonly pid?: number;
};

function worker(directory: string, maxConcurrentRuns: number, repoRoot = "workspace.example") {
  const source = `
    import NodeProcess from "node:process";
    import { acquireLocalCiBudget } from ${JSON.stringify(new URL("./lastcode-ci-budget.ts", import.meta.url).href)};
    const controller = new AbortController();
    let lease;
    const send = (message) => NodeProcess.send(message);
    NodeProcess.on("message", async (message) => {
      if (message.type === "start") {
        try {
          lease = await acquireLocalCiBudget({
            policy: { quickCiMode: "auto", maxConcurrentRuns: ${maxConcurrentRuns}, packageConcurrency: 1, compilerThreads: 2, backgroundPriority: true },
            repoRoot: ${JSON.stringify(repoRoot)},
            directory: ${JSON.stringify(directory)},
            signal: controller.signal,
            onWaiting: (summary) => send({type: "waiting", summary}),
          });
          send({type: "acquired"});
        } catch (error) {
          send({type: controller.signal.aborted ? "cancelled" : "failed", summary: error.message});
          NodeProcess.exit(0);
        }
      } else if (message.type === "status") {
        send({type: "status", acquired: lease !== undefined});
      } else if (message.type === "abort") {
        controller.abort();
      } else if (message.type === "record-child") {
        lease.recordChild(message.pid);
        send({type: "recorded"});
      } else if (message.type === "release") {
        try {
          lease.release();
          lease.release();
          send({type: "released"});
          NodeProcess.exit(0);
        } catch (error) {
          send({type: "release-refused", summary: error.message});
        }
      } else if (message.type === "crash") {
        NodeProcess.exit(0);
      }
    });
    send({type: "ready"});
  `;
  return processWorker(source);
}

function lockWorker(directory: string, pauseAt?: "prepared" | "stale") {
  return processWorker(`
    import NodeProcess from "node:process";
    import { acquireLocalCiAdmissionLock } from ${JSON.stringify(new URL("./lastcode-ci-admission-lock.ts", import.meta.url).href)};
    import { PortableLockContentionError } from ${JSON.stringify(new URL("../lastcode-lock.mjs", import.meta.url).href)};
    let release;
    let continueGate;
    const send = (message) => NodeProcess.send(message);
    const pause = (type) => new Promise((resolve) => {
      continueGate = resolve;
      send({type});
    });
    NodeProcess.on("message", async (message) => {
      if (message.type === "start") {
        try {
          release = await acquireLocalCiAdmissionLock(${JSON.stringify(directory)}, {
            forceDirectoryLock: true,
            ${pauseAt === "prepared" ? 'onCandidatePrepared: () => pause("prepared"),' : ""}
            ${pauseAt === "stale" ? 'onStaleOwnerObserved: () => pause("stale"),' : ""}
          });
          send({type: "acquired"});
        } catch (error) {
          send({type: error instanceof PortableLockContentionError ? "contended" : "failed", summary: error.message});
          NodeProcess.exit(0);
        }
      } else if (message.type === "continue") {
        continueGate();
      } else if (message.type === "release") {
        release();
        send({type: "released"});
        NodeProcess.exit(0);
      } else if (message.type === "crash") {
        NodeProcess.exit(0);
      }
    });
    send({type: "ready"});
  `);
}

function processWorker(source: string, detached = false) {
  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    ["--input-type=module", "--eval", source],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached,
    },
  );
  children.push(child);
  const messages: WorkerMessage[] = [];
  const waiters = new Map<string, Array<(message: WorkerMessage) => void>>();
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  child.on("message", (message: WorkerMessage) => {
    const resolve = waiters.get(message.type)?.shift();
    if (resolve) resolve(message);
    else messages.push(message);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`CI fixture exited with ${code}: ${stderr}`));
    });
  });
  void closed.catch(() => undefined);
  const next = (type: string) => {
    const index = messages.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
    return Promise.race([
      new Promise<WorkerMessage>((resolve) => {
        const queue = waiters.get(type) ?? [];
        queue.push(resolve);
        waiters.set(type, queue);
      }),
      closed.then(() => {
        throw new Error(`CI fixture exited before ${type}: ${stderr}`);
      }),
    ]);
  };
  return {
    pid: child.pid!,
    closed,
    next,
    send: (message: Record<string, unknown>) => child.send(message),
    async start() {
      await next("ready");
      child.send({ type: "start" });
    },
    async release() {
      child.send({ type: "release" });
      await next("released");
      await closed;
    },
  };
}

async function leaderlessCheck() {
  const childSource = "process.stdout.write('ready\\n'); setInterval(() => {}, 60000)";
  const fixture = processWorker(
    `
    import NodeChildProcess from "node:child_process";
    import NodeProcess from "node:process";
    const child = NodeChildProcess.spawn(NodeProcess.execPath, ["--eval", ${JSON.stringify(childSource)}], {stdio: ["ignore", "pipe", "ignore"]});
    child.stdout.once("data", () => NodeProcess.send({type: "descendant-ready", pid: child.pid}));
    NodeProcess.on("message", (message) => {
      if (message.type === "exit-leader") NodeProcess.exit(0);
    });
  `,
    true,
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      // This group was captured from our detached fixture's spawn, and contains
      // only the leader and descendant started above.
      NodeProcess.kill(-fixture.pid, "SIGTERM");
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
    await fixture.closed.catch(() => undefined);
  };
  cleanups.push(stop);
  const descendant = await fixture.next("descendant-ready");
  return { ...fixture, descendantPid: descendant.pid!, stop };
}

function staleLease(directory: string, childPid: number | null = null) {
  const path = NodePath.join(directory, "stale.lease.json");
  NodeFS.writeFileSync(
    path,
    JSON.stringify({
      pid: NodeProcess.pid,
      startIdentity: "previous-process-start",
      childPid,
      childStartIdentity: childPid === null ? null : "previous-child-start",
      token: "stale",
      maxConcurrentRuns: 1,
      repoRoot: "workspace.example",
    }),
  );
  return path;
}

async function detachedCheck() {
  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import NodeProcess from "node:process";
    NodeProcess.stdin.on("data", () => NodeProcess.exit(0));
    NodeProcess.stdout.write("ready\\n");
  `,
    ],
    { detached: NodeProcess.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  const lines = NodeReadline.createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    lines.once("line", () => resolve());
    child.once("error", reject);
  });
  lines.close();
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return {
    pid: child.pid!,
    async stop() {
      child.stdin.end("stop\n");
      await closed;
    },
  };
}

describe("local CI policy", () => {
  it("decodes only the CI fragment and defaults omitted policy fields", async () => {
    const path = settingsFile(
      JSON.stringify({
        unrelatedSecret: "private.example/token",
        lastcodeLocalCi: { compilerThreads: 3 },
      }),
    );
    expect(await readLocalCiPolicy({ T3CODE_LOCAL_CI_SETTINGS_PATH: path })).toEqual({
      ...DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      compilerThreads: 3,
    });
  });

  it("uses an exact override before the selected home and supplies missing-file defaults", async () => {
    const home = temporaryDirectory();
    NodeFS.mkdirSync(NodePath.join(home, "userdata"));
    settingsFile(
      JSON.stringify({ lastcodeLocalCi: { compilerThreads: 6 } }),
      NodePath.join(home, "userdata"),
    );
    const override = settingsFile(JSON.stringify({ lastcodeLocalCi: { compilerThreads: 4 } }));
    expect((await readLocalCiPolicy({ T3CODE_HOME: home })).compilerThreads).toBe(6);
    expect(
      (await readLocalCiPolicy({ T3CODE_HOME: home, T3CODE_LOCAL_CI_SETTINGS_PATH: override }))
        .compilerThreads,
    ).toBe(4);
    expect(
      await readLocalCiPolicy({
        T3CODE_HOME: home,
        T3CODE_LOCAL_CI_SETTINGS_PATH: NodePath.join(home, "absent.json"),
      }),
    ).toEqual(DEFAULT_LASTCODE_LOCAL_CI_SETTINGS);
  });

  it("defaults to the installed LastCode settings path", async () => {
    const home = temporaryDirectory();
    vi.mocked(NodeOS.homedir).mockReturnValue(home);
    const userdata = NodePath.join(home, ".lastcode", "userdata");
    NodeFS.mkdirSync(userdata, { recursive: true });
    settingsFile(JSON.stringify({ lastcodeLocalCi: { backgroundPriority: false } }), userdata);
    expect((await readLocalCiPolicy({})).backgroundPriority).toBe(false);
  });

  it("supplies defaults when the fragment is absent", async () => {
    const path = settingsFile(JSON.stringify({ unrelatedSecret: "private.example/token" }));
    expect(await readLocalCiPolicy({ T3CODE_LOCAL_CI_SETTINGS_PATH: path })).toEqual(
      DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
    );
  });

  it("reports invalid configuration without leaking file contents", async () => {
    const secret = "private.example/token";
    const path = settingsFile(
      JSON.stringify({ unrelatedSecret: secret, lastcodeLocalCi: { maxConcurrentRuns: secret } }),
    );
    const failure = await readLocalCiPolicy({ T3CODE_LOCAL_CI_SETTINGS_PATH: path }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Invalid local CI settings");
    expect(String(failure)).not.toContain(secret);
    NodeFS.writeFileSync(path, `{"secret":"${secret}",broken`);
    await expect(readLocalCiPolicy({ T3CODE_LOCAL_CI_SETTINGS_PATH: path })).rejects.toThrow(
      "valid JSON",
    );
    NodeFS.writeFileSync(path, "null");
    await expect(readLocalCiPolicy({ T3CODE_LOCAL_CI_SETTINGS_PATH: path })).rejects.toThrow(
      "must contain an object",
    );
  });
});

describe("machine-wide local CI admission", () => {
  it("returns immediately when the admission mutex is held", async () => {
    const directory = temporaryDirectory();
    const releaseMutex = await acquireLocalCiAdmissionLock(directory);
    const onWaiting = vi.fn();
    try {
      expect(
        await tryAcquireLocalCiBudget({
          policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
          repoRoot: "workspace.example",
          directory,
          onWaiting,
        }),
      ).toBeUndefined();
      expect(onWaiting).not.toHaveBeenCalled();
      expect(
        NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json")),
      ).toHaveLength(0);
    } finally {
      releaseMutex();
    }
  });

  it("claims an available slot and releases its lease", async () => {
    const directory = temporaryDirectory();
    const lease = await tryAcquireLocalCiBudget({
      policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      repoRoot: "workspace.example",
      directory,
    });
    expect(lease).toBeDefined();
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".lease.json")),
    ).toHaveLength(1);
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json")),
    ).toHaveLength(0);
    lease!.release();
    lease!.release();
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".lease.json")),
    ).toHaveLength(0);
  });

  it("declines a try under the strictest active limit without leaving a waiter", async () => {
    const directory = temporaryDirectory();
    const owner = await acquireLocalCiBudget({
      policy: { ...DEFAULT_LASTCODE_LOCAL_CI_SETTINGS, maxConcurrentRuns: 1 },
      repoRoot: "first-worktree.example",
      directory,
    });
    try {
      expect(
        await tryAcquireLocalCiBudget({
          policy: { ...DEFAULT_LASTCODE_LOCAL_CI_SETTINGS, maxConcurrentRuns: 4 },
          repoRoot: "second-worktree.example",
          directory,
        }),
      ).toBeUndefined();
      expect(
        NodeFS.readdirSync(directory).filter((name) => name.endsWith(".lease.json")),
      ).toHaveLength(1);
      expect(
        NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json")),
      ).toHaveLength(0);
    } finally {
      owner.release();
    }
  });

  it("does not overtake a registered live waiter even when capacity is free", async () => {
    const directory = temporaryDirectory();
    const waiterPath = NodePath.join(directory, "queued.waiter.json");
    const waiter = {
      pid: NodeProcess.pid,
      startIdentity: ProcessIdentity.getCurrentProcessStartIdentity(),
      token: "queued",
      order: 1,
    };
    NodeFS.writeFileSync(waiterPath, JSON.stringify(waiter));
    expect(
      await tryAcquireLocalCiBudget({
        policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
        repoRoot: "workspace.example",
        directory,
      }),
    ).toBeUndefined();
    expect(JSON.parse(NodeFS.readFileSync(waiterPath, "utf8"))).toEqual(waiter);
    expect(NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json"))).toEqual([
      "queued.waiter.json",
    ]);
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".lease.json")),
    ).toHaveLength(0);
  });

  it("honors the strictest running limit across separate worktrees", async () => {
    const directory = temporaryDirectory();
    const first = worker(directory, 2, "first-worktree.example");
    const second = worker(directory, 4, "second-worktree.example");
    const third = worker(directory, 4, "third-worktree.example");
    await first.start();
    await first.next("acquired");
    await second.start();
    await second.next("acquired");
    await third.start();
    expect((await third.next("waiting")).summary).toContain("limit 2");
    third.send({ type: "status" });
    expect((await third.next("status")).acquired).toBe(false);
    await first.release();
    await third.next("acquired");
    await second.release();
    await third.release();
  });

  it("cancels a queued process without reserving capacity", async () => {
    const directory = temporaryDirectory();
    const owner = worker(directory, 1);
    const queued = worker(directory, 1);
    await owner.start();
    await owner.next("acquired");
    await queued.start();
    await queued.next("waiting");
    queued.send({ type: "abort" });
    await queued.next("cancelled");
    await queued.closed;
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".lease.json")),
    ).toHaveLength(1);
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json")),
    ).toHaveLength(0);
    await owner.release();
  });

  it("admits registered waiters in arrival order", async () => {
    const directory = temporaryDirectory();
    const owner = worker(directory, 1);
    await owner.start();
    await owner.next("acquired");
    const first = worker(directory, 1, "first-waiter.example");
    const second = worker(directory, 1, "second-waiter.example");
    const third = worker(directory, 1, "third-waiter.example");
    await first.start();
    expect((await first.next("waiting")).summary).toContain("queue position 1");
    await second.start();
    expect((await second.next("waiting")).summary).toContain("queue position 2");
    await third.start();
    expect((await third.next("waiting")).summary).toContain("queue position 3");
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json")),
    ).toHaveLength(3);

    await owner.release();
    await first.next("acquired");
    second.send({ type: "status" });
    third.send({ type: "status" });
    expect((await second.next("status")).acquired).toBe(false);
    expect((await third.next("status")).acquired).toBe(false);
    await first.release();
    await second.next("acquired");
    third.send({ type: "status" });
    expect((await third.next("status")).acquired).toBe(false);
    await second.release();
    await third.next("acquired");
    await third.release();
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json")),
    ).toHaveLength(0);
  });

  it("removes an exited waiter before admitting the next live waiter", async () => {
    const directory = temporaryDirectory();
    const owner = worker(directory, 1);
    await owner.start();
    await owner.next("acquired");
    const exited = worker(directory, 1);
    await exited.start();
    await exited.next("waiting");
    exited.send({ type: "crash" });
    await exited.closed;
    const next = worker(directory, 1);
    await next.start();
    expect((await next.next("waiting")).summary).toContain("queue position 1");
    expect(
      NodeFS.readdirSync(directory).filter((name) => name.endsWith(".waiter.json")),
    ).toHaveLength(1);
    await owner.release();
    await next.next("acquired");
    await next.release();
  });

  it("reclaims an exited owner without relying on lease age", async () => {
    const directory = temporaryDirectory();
    const owner = worker(directory, 1);
    const queued = worker(directory, 1);
    await owner.start();
    await owner.next("acquired");
    await queued.start();
    await queued.next("waiting");
    owner.send({ type: "crash" });
    await owner.closed;
    await queued.next("acquired");
    await queued.release();
  });

  it("reclaims old owners and waiters whose live PID now has a different start identity", async () => {
    const directory = temporaryDirectory();
    const leasePath = staleLease(directory);
    const waiterPath = NodePath.join(directory, "stale.waiter.json");
    NodeFS.writeFileSync(
      waiterPath,
      JSON.stringify({
        pid: NodeProcess.pid,
        startIdentity: "previous-process-start",
        token: "stale",
        order: 1,
      }),
    );
    const lease = await tryAcquireLocalCiBudget({
      policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      repoRoot: "workspace.example",
      directory,
    });
    expect(lease).toBeDefined();
    expect(NodeFS.existsSync(leasePath)).toBe(false);
    expect(NodeFS.existsSync(waiterPath)).toBe(false);
    lease!.release();
  });

  it("distinguishes a replacement child process or group from the recorded child", async () => {
    const directory = temporaryDirectory();
    const check = await detachedCheck();
    const path = staleLease(directory, check.pid);
    const lease = await tryAcquireLocalCiBudget({
      policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      repoRoot: "workspace.example",
      directory,
    });
    expect(lease).toBeDefined();
    expect(NodeFS.existsSync(path)).toBe(false);
    // Reclaiming stale metadata does not terminate the replacement process.
    expect(ProcessIdentity.isProcessRunning(check.pid)).toBe(true);
    lease!.release();
    await check.stop();
  });

  it("keeps capacity when an occupied PID's start identity is inaccessible", async () => {
    const directory = temporaryDirectory();
    const path = staleLease(directory);
    const lookup = vi.spyOn(ProcessIdentity, "readProcessIdentities").mockReturnValue(new Map());
    try {
      expect(
        await tryAcquireLocalCiBudget({
          policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
          repoRoot: "workspace.example",
          directory,
        }),
      ).toBeUndefined();
      expect(NodeFS.existsSync(path)).toBe(true);
    } finally {
      lookup.mockRestore();
    }
  });

  it("keeps capacity when a live child group's start identity is inaccessible", async () => {
    const directory = temporaryDirectory();
    const check = await detachedCheck();
    const path = staleLease(directory, check.pid);
    const knownOwner = ProcessIdentity.readProcessIdentities([NodeProcess.pid]);
    const lookup = vi.spyOn(ProcessIdentity, "readProcessIdentities").mockReturnValue(knownOwner);
    try {
      expect(
        await tryAcquireLocalCiBudget({
          policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
          repoRoot: "workspace.example",
          directory,
        }),
      ).toBeUndefined();
      expect(NodeFS.existsSync(path)).toBe(true);
    } finally {
      lookup.mockRestore();
      await check.stop();
    }
  });

  it.skipIf(NodeProcess.platform === "win32")(
    "keeps a leaderless owned group until its descendant exits",
    async () => {
      const directory = temporaryDirectory();
      const owner = worker(directory, 1);
      await owner.start();
      await owner.next("acquired");
      const check = await leaderlessCheck();
      owner.send({ type: "record-child", pid: check.pid });
      await owner.next("recorded");
      const leasePath = NodeFS.readdirSync(directory).find((name) => name.endsWith(".lease.json"))!;
      const stored = JSON.parse(NodeFS.readFileSync(NodePath.join(directory, leasePath), "utf8"));
      expect(stored.startIdentity).toBe(
        ProcessIdentity.readProcessIdentities([owner.pid]).get(owner.pid)?.startIdentity,
      );
      expect(stored.childStartIdentity).toBe(
        ProcessIdentity.readProcessIdentities([check.pid]).get(check.pid)?.startIdentity,
      );
      check.send({ type: "exit-leader" });
      await check.closed;
      expect(ProcessIdentity.isProcessRunning(check.pid)).toBe(false);
      expect(ProcessIdentity.isProcessRunning(check.descendantPid)).toBe(true);
      owner.send({ type: "crash" });
      await owner.closed;
      const queued = worker(directory, 1);
      await queued.start();
      await queued.next("waiting");
      queued.send({ type: "status" });
      expect((await queued.next("status")).acquired).toBe(false);
      await check.stop();
      await queued.next("acquired");
      await queued.release();
    },
  );

  it("retains a living child group after its owner exits and refuses early release", async () => {
    const directory = temporaryDirectory();
    const owner = worker(directory, 1);
    await owner.start();
    await owner.next("acquired");
    const check = await detachedCheck();
    owner.send({ type: "record-child", pid: check.pid });
    await owner.next("recorded");
    owner.send({ type: "release" });
    await owner.next("release-refused");
    owner.send({ type: "crash" });
    await owner.closed;
    const queued = worker(directory, 1);
    await queued.start();
    await queued.next("waiting");
    queued.send({ type: "status" });
    expect((await queued.next("status")).acquired).toBe(false);
    await check.stop();
    await queued.next("acquired");
    await queued.release();
  });

  it("keeps explicitly separate budgets independent and rejects pre-cancelled admission", async () => {
    const first = await acquireLocalCiBudget({
      policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      repoRoot: "workspace.example",
      directory: temporaryDirectory(),
    });
    const second = await acquireLocalCiBudget({
      policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      repoRoot: "workspace.example",
      directory: temporaryDirectory(),
    });
    first.release();
    first.release();
    second.release();
    const controller = new AbortController();
    controller.abort();
    const directory = temporaryDirectory();
    await expect(
      acquireLocalCiBudget({
        policy: DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
        repoRoot: "workspace.example",
        directory,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(NodeFS.readdirSync(directory)).toHaveLength(0);
  });
});

describe("portable CI admission mutex", () => {
  it("reclaims a directory lock whose PID now belongs to a different process", async () => {
    const directory = temporaryDirectory();
    const lockPath = NodePath.join(directory, "admission.lock.d");
    const token = "11111111-1111-1111-1111-111111111111";
    NodeFS.mkdirSync(lockPath);
    NodeFS.writeFileSync(
      NodePath.join(lockPath, `owner-${token}.json`),
      JSON.stringify({ pid: NodeProcess.pid, startIdentity: "previous-process-start", token }),
    );
    const release = await acquireLocalCiAdmissionLock(directory, { forceDirectoryLock: true });
    expect(NodeFS.readdirSync(lockPath)).not.toContain(`owner-${token}.json`);
    release();
  });
  it("publishes only prepared ownership and ignores a crashed private candidate", async () => {
    const directory = temporaryDirectory();
    const incomplete = lockWorker(directory, "prepared");
    await incomplete.start();
    await incomplete.next("prepared");
    expect(NodeFS.existsSync(NodePath.join(directory, "admission.lock.d"))).toBe(false);
    const candidates = NodeFS.readdirSync(directory).filter((name) =>
      name.startsWith(".admission-candidate-"),
    );
    expect(candidates).toHaveLength(1);
    expect(NodeFS.readdirSync(NodePath.join(directory, candidates[0]!))).toHaveLength(1);

    // The candidate has a complete owner record, but it has not claimed the mutex.
    const release = await acquireLocalCiAdmissionLock(directory, { forceDirectoryLock: true });
    release();
    incomplete.send({ type: "crash" });
    await incomplete.closed;
    expect(NodeFS.existsSync(NodePath.join(directory, candidates[0]!))).toBe(true);
    // A crash immediately after mkdir also leaves only an ignored private path.
    NodeFS.mkdirSync(NodePath.join(directory, ".admission-candidate-interrupted"));
    const releaseAfterCrash = await acquireLocalCiAdmissionLock(directory, {
      forceDirectoryLock: true,
    });
    releaseAfterCrash();
  });

  it("never lets a delayed stale reclaimer remove a newly acquired owner", async () => {
    const directory = temporaryDirectory();
    const previous = lockWorker(directory);
    await previous.start();
    await previous.next("acquired");
    previous.send({ type: "crash" });
    await previous.closed;

    const delayed = lockWorker(directory, "stale");
    await delayed.start();
    await delayed.next("stale");
    const winner = lockWorker(directory);
    await winner.start();
    await winner.next("acquired");
    const ownerFiles = NodeFS.readdirSync(NodePath.join(directory, "admission.lock.d"));
    delayed.send({ type: "continue" });
    await delayed.next("contended");
    await delayed.closed;
    expect(NodeFS.readdirSync(NodePath.join(directory, "admission.lock.d"))).toEqual(ownerFiles);
    const lateContender = lockWorker(directory);
    await lateContender.start();
    await lateContender.next("contended");
    await lateContender.closed;
    await winner.release();
  });
});
