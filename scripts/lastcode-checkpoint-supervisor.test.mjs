import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  boundedCommandDiagnostic,
  checkpointEnvironment,
  checkpointSchedulerPid,
  checkpointFailureMessage,
  checkpointIncidentFingerprint,
  changedGitlink,
  latestFailedCheckpointRun,
  projectActionTrustAllowlist,
  reconcilePrimaryProjectActions,
  refreshPrimaryCheckout,
  refreshInstalledSupervisor,
  runCheckpointSupervisor,
  selectPrimaryWorktree,
} from "./lastcode-checkpoint-supervisor.mjs";
import { refreshPrimaryCheckoutTransaction } from "./lastcode-primary-checkout-transaction.mjs";

function fixture(overrides = {}) {
  const states = [];
  const messages = [];
  let state = overrides.state ?? null;
  let now = 0;
  const dependencies = {
    latestFailedCheckpointRun: () => ({
      status: "failed",
      upstreamTag: "v0.0.35-nightly.20260826.1195",
      failurePhase: "rebase",
      recoveryBranch: "sync/nightly/v0.0.35-nightly.20260826.1195",
      error: "rebase failed",
    }),
    loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-maintenance" }),
    loadState: () => state,
    now: () => `2026-08-26T00:00:0${now++}.000Z`,
    notify: vi.fn(),
    reconcileProjectActions: vi.fn(),
    refreshPrimaryCheckout: vi.fn(),
    refreshSupervisor: vi.fn(),
    runPhase: vi.fn(),
    sendThread: (threadId, message) => messages.push({ message, threadId }),
    writeState: (next) => {
      state = next;
      states.push(next);
    },
    ...overrides.dependencies,
  };
  return {
    dependencies,
    get state() {
      return state;
    },
    messages,
    states,
  };
}

describe("LastCode checkpoint supervisor", () => {
  it("only accepts the actual scheduler parent identity", () => {
    expect(checkpointSchedulerPid({}, 42)).toBeUndefined();
    expect(checkpointSchedulerPid({ LASTCODE_CHECKPOINT_SCHEDULER_PID: "42" }, 42)).toBe(42);
    for (const value of ["", "0", "-1", "42.5", "042", "43", "bad"]) {
      expect(() =>
        checkpointSchedulerPid({ LASTCODE_CHECKPOINT_SCHEDULER_PID: value }, 42),
      ).toThrow("parent process");
    }
  });

  it("records daily scheduler identity on success and failure", () => {
    for (const failing of [false, true]) {
      const test = fixture({
        dependencies: {
          runPhase: vi.fn(() => {
            if (failing) throw new Error("failed");
          }),
        },
      });
      const run = () =>
        runCheckpointSupervisor(
          {
            environment: {
              LASTCODE_CHECKPOINT_SCHEDULER_PID: String(process.ppid),
            },
          },
          test.dependencies,
        );
      if (failing) expect(run).toThrow("failed");
      else run();
      expect(test.state).toMatchObject({
        supervisorPid: process.pid,
        launchdPid: process.ppid,
        status: failing ? "failed" : "success",
      });
    }
  });

  it("runs the complete checkpoint pipeline and records terminal success", () => {
    const test = fixture();

    expect(runCheckpointSupervisor({}, test.dependencies)).toMatchObject({
      status: "success",
      supervisorPid: process.pid,
      launchdPid: process.pid,
      phase: "complete",
    });
    expect(test.dependencies.runPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "fetch",
      "checkout",
      "dependencies",
      "checkpoint",
    ]);
    expect(test.dependencies.runPhase.mock.calls.at(-1)?.[2]).toContain(
      "--supersede-failed-recovery",
    );
    expect(test.dependencies.runPhase.mock.calls.at(-1)?.[2]).toContain("--promote");
    expect(test.dependencies.runPhase.mock.calls.at(-1)?.[2]).not.toContain(
      "--promote-if-no-open-prs",
    );
    expect(test.dependencies.refreshSupervisor).toHaveBeenCalledOnce();
    expect(test.dependencies.refreshPrimaryCheckout).toHaveBeenCalledOnce();
    expect(test.dependencies.reconcileProjectActions).toHaveBeenCalledWith(undefined, []);
    expect(test.messages).toEqual([]);
    expect(test.states.at(-1)).toMatchObject({ status: "success", phase: "complete" });
  });

  it("selects the repository's primary checkout", () => {
    expect(
      selectPrimaryWorktree(
        "worktree /srv/example/lastCode\n\nworktree /srv/example/lastCode-worktrees/lastcode-automation\n",
      ),
    ).toBe("/srv/example/lastCode");
  });

  it("installs dependencies before returning a current primary checkout", () => {
    const execute = vi.fn((_phase, _cwd, _command, args) => {
      if (args[0] === "worktree") return "worktree /srv/example/lastCode\n";
      if (args[0] === "branch") return "lastcode/main";
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse") return "1111111";
      return "";
    });

    expect(
      refreshPrimaryCheckout("/srv/example/lastCode-worktrees/lastcode-automation", {}, execute),
    ).toBe("/srv/example/lastCode");
    expect(execute.mock.calls.find(([, , , args]) => args[0] === "install")).toEqual([
      "checkout-dependencies",
      "/srv/example/lastCode",
      "/srv/example/lastCode-worktrees/lastcode-automation/node_modules/.bin/vp",
      ["install", "--frozen-lockfile"],
      {},
    ]);
    expect(execute.mock.calls.some(([, , command]) => command === process.execPath)).toBe(false);
  });

  it("runs Project Action reconciliation against the refreshed primary checkout", () => {
    const execute = vi.fn();
    reconcilePrimaryProjectActions(
      "/srv/example/lastCode",
      "/Users/example",
      ["lc-wait-for-pr"],
      { HOME: "/Users/example" },
      execute,
    );

    expect(execute).toHaveBeenCalledWith(
      "project-actions",
      "/srv/example/lastCode",
      process.execPath,
      [
        "/srv/example/lastCode/scripts/lastcode-project-actions.mjs",
        "reconcile",
        "--repo-root",
        "/srv/example/lastCode",
        "--base-dir",
        "/Users/example/.lastcode",
        "--trusted-source-id",
        "lc-wait-for-pr",
      ],
      { HOME: "/Users/example" },
    );
  });

  it("validates and normalizes the environment-local Project Action trust allowlist", () => {
    expect(
      projectActionTrustAllowlist({
        trustedProjectActionIds: ["lc-wait-for-pr", "lc-wait-for-pr"],
      }),
    ).toEqual(["lc-wait-for-pr"]);
    expect(() => projectActionTrustAllowlist({ trustedProjectActionIds: ["wait-for-pr"] })).toThrow(
      "trust entries are invalid",
    );
  });

  it("detects every changed submodule gitlink", () => {
    const rawDiff = ":160000 160000 1111111 2222222 M\0.repos/example\0";
    expect(changedGitlink(rawDiff)).toBe(".repos/example");
    expect(changedGitlink(":100644 100644 1111111 2222222 M\0README.md\0")).toBeNull();
  });

  it("uses a guarded native checkout to preserve ignored local content", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-checkout-"));
    const git = (args, options = {}) => {
      const result = NodeChildProcess.spawnSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        input: options.input,
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(["init", "--quiet", "--initial-branch=lastcode/main"]);
    git(["config", "user.email", "checkpoint@example.com"]);
    git(["config", "user.name", "Checkpoint Test"]);
    NodeFS.writeFileSync(NodePath.join(directory, ".gitignore"), "local.env\n");
    git(["add", ".gitignore"]);
    git(["commit", "--quiet", "--message", "previous"]);
    const previousCommit = git(["rev-parse", "HEAD"]);
    const localPath = NodePath.join(directory, "local.env");
    NodeFS.writeFileSync(localPath, "promoted\n");
    git(["add", "--force", "local.env"]);
    git(["commit", "--quiet", "--message", "promoted"]);
    const promotedCommit = git(["rev-parse", "HEAD"]);
    git(["reset", "--hard", previousCommit]);
    NodeFS.writeFileSync(localPath, "local\n");

    await expect(
      refreshPrimaryCheckoutTransaction(directory, previousCommit, promotedCommit),
    ).rejects.toThrow("would be overwritten");
    expect(NodeFS.readFileSync(localPath, "utf8")).toBe("local\n");
    expect(git(["rev-parse", "HEAD"])).toBe(previousCommit);
    expect(git(["branch", "--show-current"])).toBe("lastcode/main");

    NodeFS.rmSync(localPath);
    await refreshPrimaryCheckoutTransaction(directory, previousCommit, promotedCommit);
    expect(git(["rev-parse", "HEAD"])).toBe(promotedCommit);
    expect(git(["branch", "--show-current"])).toBe("lastcode/main");
    expect(NodeFS.readFileSync(localPath, "utf8")).toBe("promoted\n");
    NodeFS.rmSync(directory, { recursive: true });
  });

  it("preserves a tracked edit that appears immediately before checkout", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-checkout-"));
    const git = (args) => {
      const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(["init", "--quiet", "--initial-branch=lastcode/main"]);
    git(["config", "user.email", "checkpoint@example.com"]);
    git(["config", "user.name", "Checkpoint Test"]);
    const trackedPath = NodePath.join(directory, "tracked.txt");
    NodeFS.writeFileSync(trackedPath, "previous\n");
    git(["add", "tracked.txt"]);
    git(["commit", "--quiet", "--message", "previous"]);
    const previousCommit = git(["rev-parse", "HEAD"]);
    NodeFS.writeFileSync(trackedPath, "promoted\n");
    git(["commit", "--quiet", "--all", "--message", "promoted"]);
    const promotedCommit = git(["rev-parse", "HEAD"]);
    git(["reset", "--hard", previousCommit]);

    await expect(
      refreshPrimaryCheckoutTransaction(directory, previousCommit, promotedCommit, {
        beforeCheckout: () => NodeFS.writeFileSync(trackedPath, "user edit\n"),
      }),
    ).rejects.toThrow("would be overwritten");

    expect(NodeFS.readFileSync(trackedPath, "utf8")).toBe("user edit\n");
    expect(git(["rev-parse", "HEAD"])).toBe(previousCommit);
    expect(git(["status", "--porcelain=v1"])).toBe("M tracked.txt");
    NodeFS.rmSync(directory, { recursive: true });
  });

  it("preserves a branch commit made before the transaction prepares", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-checkout-"));
    const git = (args, options = {}) => {
      const result = NodeChildProcess.spawnSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        input: options.input,
      });
      if (result.status !== 0 && !options.allowFailure) throw new Error(result.stderr);
      return { status: result.status, stdout: result.stdout.trim() };
    };
    git(["init", "--quiet", "--initial-branch=lastcode/main"]);
    git(["config", "user.email", "checkpoint@example.com"]);
    git(["config", "user.name", "Checkpoint Test"]);
    NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "previous\n");
    git(["add", "tracked.txt"]);
    git(["commit", "--quiet", "--message", "previous"]);
    const previousCommit = git(["rev-parse", "HEAD"]).stdout;
    NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "promoted\n");
    git(["commit", "--quiet", "--all", "--message", "promoted"]);
    const promotedCommit = git(["rev-parse", "HEAD"]).stdout;
    git(["reset", "--hard", previousCommit]);
    const concurrentCommit = git([
      "commit-tree",
      `${previousCommit}^{tree}`,
      "-p",
      previousCommit,
      "-m",
      "concurrent",
    ]).stdout;
    git(["update-ref", "refs/heads/lastcode/main", concurrentCommit, previousCommit]);

    await expect(
      refreshPrimaryCheckoutTransaction(directory, previousCommit, promotedCommit),
    ).rejects.toThrow();
    expect(git(["rev-parse", "refs/heads/lastcode/main"]).stdout).toBe(concurrentCommit);
    expect(git(["rev-parse", "HEAD"]).stdout).toBe(concurrentCommit);
    expect(git(["branch", "--show-current"]).stdout).toBe("lastcode/main");
    NodeFS.rmSync(directory, { recursive: true });
  });

  it("preserves a same-commit branch switch without forcing a rollback", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-checkout-"));
    const git = (args) => {
      const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(["init", "--quiet", "--initial-branch=lastcode/main"]);
    git(["config", "user.email", "checkpoint@example.com"]);
    git(["config", "user.name", "Checkpoint Test"]);
    NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "previous\n");
    git(["add", "tracked.txt"]);
    git(["commit", "--quiet", "--message", "previous"]);
    const previousCommit = git(["rev-parse", "HEAD"]);
    NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "promoted\n");
    git(["commit", "--quiet", "--all", "--message", "promoted"]);
    const promotedCommit = git(["rev-parse", "HEAD"]);
    git(["reset", "--hard", previousCommit]);
    git(["branch", "feature/in-progress", previousCommit]);
    git(["switch", "--quiet", "feature/in-progress"]);

    await expect(
      refreshPrimaryCheckoutTransaction(directory, previousCommit, promotedCommit),
    ).rejects.toThrow("changed branches before refresh");
    expect(git(["branch", "--show-current"])).toBe("feature/in-progress");
    expect(git(["rev-parse", "refs/heads/lastcode/main"])).toBe(previousCommit);
    expect(git(["status", "--porcelain=v1"])).toBe("M  tracked.txt");
    NodeFS.rmSync(directory, { recursive: true });
  });

  it("rejects a commit injected immediately before checkout", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-checkout-"));
    const git = (args, allowFailure = false) => {
      const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      if (result.status !== 0 && !allowFailure) throw new Error(result.stderr);
      return result;
    };
    git(["init", "--quiet", "--initial-branch=lastcode/main"]);
    git(["config", "user.email", "checkpoint@example.com"]);
    git(["config", "user.name", "Checkpoint Test"]);
    NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "previous\n");
    git(["add", "tracked.txt"]);
    git(["commit", "--quiet", "--message", "previous"]);
    const previousCommit = git(["rev-parse", "HEAD"]).stdout.trim();
    NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "promoted\n");
    git(["commit", "--quiet", "--all", "--message", "promoted"]);
    const promotedCommit = git(["rev-parse", "HEAD"]).stdout.trim();
    git(["reset", "--hard", previousCommit]);
    await expect(
      refreshPrimaryCheckoutTransaction(directory, previousCommit, promotedCommit, {
        beforeCheckout: () => {
          expect(git(["commit", "--allow-empty", "--message", "concurrent"]).status).toBe(0);
        },
      }),
    ).rejects.toThrow("Primary LastCode branch changed before checkout refresh");
    expect(git(["branch", "--show-current"]).stdout.trim()).toBe("lastcode/main");
    expect(git(["rev-parse", "HEAD"]).stdout.trim()).not.toBe(promotedCommit);
    NodeFS.rmSync(directory, { recursive: true });
  });

  it("safely repoints a clean primary LastCode checkout after rewritten promotion", () => {
    const calls = [];
    let headChecks = 0;
    const execute = vi.fn((phase, cwd, command, args, environment, options) => {
      calls.push({ args, command, cwd, environment, options, phase });
      if (args[0] === "worktree") return "worktree /srv/example/lastCode\n";
      if (args[0] === "branch") return "lastcode/main";
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headChecks += 1;
        return headChecks < 3 ? "1111111" : "2222222";
      }
      if (args[0] === "rev-parse") return "2222222";
      return "";
    });

    refreshPrimaryCheckout("/srv/example/lastCode-worktrees/lastcode-automation", {}, execute);

    expect(calls.map(({ args }) => args)).toEqual([
      ["worktree", "list", "--porcelain"],
      ["branch", "--show-current"],
      ["status", "--porcelain=v1", "--untracked-files=all"],
      ["rev-parse", "HEAD"],
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/lastcode/main:refs/remotes/origin/lastcode/main",
      ],
      ["branch", "--show-current"],
      ["status", "--porcelain=v1", "--untracked-files=all"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "refs/remotes/origin/lastcode/main"],
      ["diff-tree", "-r", "--no-commit-id", "--raw", "-z", "1111111", "2222222"],
      ["update-ref", "refs/lastcode/primary-checkout-backups/1111111", "1111111"],
      [
        "/srv/example/lastCode-worktrees/lastcode-automation/scripts/lastcode-primary-checkout-transaction.mjs",
        "/srv/example/lastCode",
        "1111111",
        "2222222",
      ],
      ["branch", "--show-current"],
      ["status", "--porcelain=v1", "--untracked-files=all"],
      ["rev-parse", "HEAD"],
      ["install", "--frozen-lockfile"],
    ]);
    const transactionCall = calls.find(({ command }) => command === process.execPath);
    expect(transactionCall?.cwd).toBe("/srv/example/lastCode-worktrees/lastcode-automation");
    expect(calls.find(({ args }) => args[0] === "install")).toMatchObject({
      command: "/srv/example/lastCode-worktrees/lastcode-automation/node_modules/.bin/vp",
      cwd: "/srv/example/lastCode",
      phase: "checkout-dependencies",
    });
    expect(
      calls
        .slice(1)
        .filter(({ command }) => command !== process.execPath)
        .every(({ cwd }) => cwd === "/srv/example/lastCode"),
    ).toBe(true);
  });

  it("reports an edit preserved during checkout in the same run", () => {
    let headChecks = 0;
    let statusChecks = 0;
    const execute = vi.fn((_phase, _cwd, command, args) => {
      if (args[0] === "worktree") return "worktree /srv/example/lastCode\n";
      if (args[0] === "branch") return "lastcode/main";
      if (args[0] === "status") {
        statusChecks += 1;
        return statusChecks < 3 ? "" : " M unchanged.txt";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        headChecks += 1;
        return headChecks < 3 ? "1111111" : "2222222";
      }
      if (args[0] === "rev-parse") return "2222222";
      if (command === process.execPath) return "";
      return "";
    });

    expect(() =>
      refreshPrimaryCheckout("/srv/example/lastCode-worktrees/lastcode-automation", {}, execute),
    ).toThrow("uncommitted or untracked changes");
    expect(execute.mock.calls.filter(([, , command]) => command === process.execPath)).toHaveLength(
      1,
    );
  });

  it("refuses to reset when the primary checkout changes during fetch", () => {
    let branchChecks = 0;
    const execute = vi.fn((_phase, _cwd, command, args) => {
      if (args[0] === "worktree") return "worktree /srv/example/lastCode\n";
      if (args[0] === "branch") {
        branchChecks += 1;
        return branchChecks === 1 ? "lastcode/main" : "feature/in-progress";
      }
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse") return "1111111";
      return "";
    });

    expect(() =>
      refreshPrimaryCheckout("/srv/example/lastCode-worktrees/lastcode-automation", {}, execute),
    ).toThrow("found 'feature/in-progress'");
    expect(execute.mock.calls.some(([, , , args]) => args[0] === "checkout")).toBe(false);
  });

  it("refuses to reset when the primary commit changes during fetch", () => {
    let commitChecks = 0;
    const execute = vi.fn((_phase, _cwd, command, args) => {
      if (args[0] === "worktree") return "worktree /srv/example/lastCode\n";
      if (args[0] === "branch") return "lastcode/main";
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        commitChecks += 1;
        return commitChecks === 1 ? "1111111" : "3333333";
      }
      return "2222222";
    });

    expect(() =>
      refreshPrimaryCheckout("/srv/example/lastCode-worktrees/lastcode-automation", {}, execute),
    ).toThrow("changed while its remote was being refreshed");
    expect(execute.mock.calls.some(([, , , args]) => args[0] === "update-ref")).toBe(false);
  });

  it("propagates a transactional checkout failure without retrying destructively", () => {
    const execute = vi.fn((_phase, _cwd, command, args) => {
      if (args[0] === "worktree") return "worktree /srv/example/lastCode\n";
      if (args[0] === "branch") return "lastcode/main";
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "1111111";
      if (args[0] === "rev-parse") return "2222222";
      if (command === process.execPath)
        throw new Error("local.env would be overwritten by checkout");
      return "";
    });

    expect(() =>
      refreshPrimaryCheckout("/srv/example/lastCode-worktrees/lastcode-automation", {}, execute),
    ).toThrow("would be overwritten");
    expect(execute.mock.calls.filter(([, , command]) => command === process.execPath)).toHaveLength(
      1,
    );
    expect(execute.mock.calls.some(([, , , args]) => args[0] === "reset")).toBe(false);
  });

  it("refuses to refresh a dirty primary checkout", () => {
    const execute = vi.fn((_phase, _cwd, _command, args) => {
      if (args[0] === "worktree") return "worktree /srv/example/lastCode\n";
      if (args[0] === "branch") return "lastcode/main";
      if (args[0] === "status") return "?? local-notes.txt";
      return "";
    });

    expect(() =>
      refreshPrimaryCheckout("/srv/example/lastCode-worktrees/lastcode-automation", {}, execute),
    ).toThrow("uncommitted or untracked changes");
    expect(execute.mock.calls.some(([, , , args]) => args[0] === "fetch")).toBe(false);
  });

  it("records a blocked primary checkout refresh as a checkpoint service failure", () => {
    const test = fixture({
      dependencies: {
        refreshPrimaryCheckout: () => {
          throw new Error("primary checkout has uncommitted changes");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "primary checkout has uncommitted changes",
    );
    expect(test.state).toMatchObject({
      status: "failed",
      phase: "checkout-refresh",
      incident: { failure: { phase: "checkout-refresh" } },
    });
  });

  it("records Project Action reconciliation failure after a successful checkout refresh", () => {
    const test = fixture({
      dependencies: {
        refreshPrimaryCheckout: () => "/srv/example/lastCode",
        reconcileProjectActions: () => {
          throw new Error("Project Action reconciliation failed");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "Project Action reconciliation failed",
    );
    expect(test.state).toMatchObject({
      status: "failed",
      phase: "project-actions",
      incident: { failure: { phase: "project-actions" } },
    });
  });

  it("persists a new checkpoint blocker before alerting one maintenance thread", () => {
    const test = fixture({
      dependencies: {
        runPhase: vi.fn((phase) => {
          if (phase === "checkpoint") throw new Error("checkpoint failed");
        }),
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("checkpoint failed");
    expect(test.states[0]).toMatchObject({
      status: "failed",
      supervisorPid: process.pid,
      phase: "checkpoint",
      incident: { alertDelivery: "pending", deliveryAttempts: 0 },
    });
    expect(test.state).toMatchObject({
      status: "failed",
      incident: { alertDelivery: "sent", deliveryAttempts: 1 },
    });
    expect(test.messages).toHaveLength(1);
    expect(test.messages[0]).toMatchObject({ threadId: "thread-maintenance" });
    expect(test.messages[0]?.message).toContain("Use this thread for the recovery");
  });

  it("does not redeliver the same blocker after acknowledgement", () => {
    const failedRun = () => {
      throw new Error("fetch failed");
    };
    const first = fixture({ dependencies: { runPhase: failedRun } });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");

    const second = fixture({
      state: first.state,
      dependencies: { runPhase: failedRun },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("fetch failed");
    expect(second.messages).toEqual([]);
    expect(second.state.incident.deliveryAttempts).toBe(1);
  });

  it("closes an ambiguously delivered alert at its original recipient after immediate recovery", () => {
    const first = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");
    expect(first.state.incident).toMatchObject({
      alertDelivery: "unknown",
      deliveryAttempts: 1,
      deliveryThreadId: "thread-maintenance",
    });

    const recovered = fixture({
      state: first.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-replacement" }),
      },
    });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0]).toMatchObject({ threadId: "thread-maintenance" });
    expect(recovered.messages[0]?.message).toContain("maintenance resolved alert");

    const stillHealthy = fixture({ state: recovered.state });
    runCheckpointSupervisor({}, stillHealthy.dependencies);
    expect(stillHealthy.messages).toEqual([]);
  });

  it("retries an ambiguous alert when the checkpoint remains failed", () => {
    const runPhase = () => {
      throw new Error("fetch failed");
    };
    const first = fixture({
      dependencies: {
        runPhase,
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");

    const second = fixture({
      state: first.state,
      dependencies: {
        runPhase,
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "replacement-thread" }),
      },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("fetch failed");
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ threadId: "thread-maintenance" });
    expect(second.state.incident).toMatchObject({ alertDelivery: "sent", deliveryAttempts: 2 });
  });

  it("reroutes a definitively rejected target when the checkpoint remains failed", () => {
    const runPhase = () => {
      throw new Error("fetch failed");
    };
    const targetRejected = () =>
      Object.assign(new Error("target rejected"), {
        diagnostic: "LastCode thread 'thread-stale' was not found.",
        phase: "alert-delivery",
      });
    const first = fixture({
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-stale" }),
        runPhase,
        sendThread: () => {
          throw targetRejected();
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");
    expect(first.state.incident).toMatchObject({
      alertDelivery: "rejected",
      deliveryAttempts: 1,
    });
    expect(first.state.incident.deliveryThreadId).toBeUndefined();

    const repaired = fixture({
      state: first.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-repaired" }),
        runPhase,
      },
    });
    expect(() => runCheckpointSupervisor({}, repaired.dependencies)).toThrow("fetch failed");
    expect(repaired.messages).toEqual([expect.objectContaining({ threadId: "thread-repaired" })]);
    expect(repaired.state.incident).toMatchObject({ alertDelivery: "sent", deliveryAttempts: 2 });
  });

  it.each([
    "Failed to issue session token.",
    "ThreadSendTargetError: LastCode thread 'thread-stale' was not found.",
    "The owning LastCode server is not available; thread send has no offline fallback.",
    "LastCode thread live send target lookup failed.",
    "LastCode thread send command id generation failed.",
    "LastCode thread send message id generation failed.",
  ])("drops a pre-dispatch rejected alert after recovery: %s", (diagnostic) => {
    const targetRejected = () =>
      Object.assign(new Error("target rejected"), {
        diagnostic,
        phase: "alert-delivery",
      });
    const failed = fixture({
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-stale" }),
        runPhase: () => {
          throw new Error("fetch failed");
        },
        sendThread: () => {
          throw targetRejected();
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("fetch failed");

    const recovered = fixture({ state: failed.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toEqual([]);
    expect(recovered.state.incident).toMatchObject({
      alertDelivery: "not-needed",
      resolutionDelivery: "not-needed",
    });
  });

  it.each(["missing", "non-executable"])("retires alerts rejected by wrapper exec: %s", (kind) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-wrapper-test-"));
    try {
      const executable = NodePath.join(directory, "runtime");
      if (kind === "non-executable")
        NodeFS.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      const wrapper = NodePath.join(directory, "lastcode-thread");
      NodeFS.writeFileSync(
        wrapper,
        '#!/bin/sh\ncase "$1" in\n  send) command="$1"; shift; exec "$1" thread "$command" ;;\nesac\n',
        { mode: 0o700 },
      );
      const result = NodeChildProcess.spawnSync("/bin/bash", [wrapper, "send", executable], {
        encoding: "utf8",
      });
      expect([126, 127]).toContain(result.status);
      const failed = fixture({
        dependencies: {
          runPhase: () => {
            throw new Error("fetch failed");
          },
          sendThread: () => {
            throw Object.assign(new Error("wrapper exec failed"), {
              phase: "alert-delivery",
              status: result.status,
              diagnostic: result.stderr,
            });
          },
        },
      });
      expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("fetch failed");
      expect(failed.state.incident.alertDelivery).toBe("rejected");
      const recovered = fixture({ state: failed.state });
      runCheckpointSupervisor({}, recovered.dependencies);
      expect(recovered.messages).toEqual([]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [127, "lastcode-thread: line 3: /example/runtime: No such file or directory"],
    [126, "lastcode-thread: line 3: /example/runtime: Permission denied"],
  ])("rejects a Bash wrapper failure without a second exec line: %s", (status, diagnostic) => {
    const failed = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
        sendThread: () => {
          throw Object.assign(new Error("exec failed"), {
            phase: "alert-delivery",
            status,
            diagnostic,
          });
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("fetch failed");
    expect(failed.state.incident.alertDelivery).toBe("rejected");
    const recovered = fixture({ state: failed.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toEqual([]);
  });

  it.each(["ENOENT", "EACCES", "ENOTDIR", "E2BIG", "ETIMEDOUT", "ENOBUFS"])(
    "distinguishes launch rejection from uncertain process failure: %s",
    (code) => {
      const failed = fixture({
        dependencies: {
          runPhase: () => {
            throw new Error("fetch failed");
          },
          sendThread: () => {
            throw Object.assign(new Error("wrapper failed"), {
              code,
              syscall: "spawnSync /example/bin/lastcode-thread",
            });
          },
        },
      });
      expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("fetch failed");
      const uncertain = code === "ETIMEDOUT" || code === "ENOBUFS";
      expect(failed.state.incident.alertDelivery).toBe(uncertain ? "unknown" : "rejected");
      const recovered = fixture({ state: failed.state });
      runCheckpointSupervisor({}, recovered.dependencies);
      expect(recovered.messages).toHaveLength(uncertain ? 1 : 0);
    },
  );

  it("keeps an explicit dispatch failure uncertain after recovery", () => {
    const failed = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
        sendThread: () => {
          throw Object.assign(new Error("dispatch timed out"), {
            phase: "alert-delivery",
            diagnostic: "LastCode thread live send dispatch failed.",
          });
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("fetch failed");
    expect(failed.state.incident.alertDelivery).toBe("unknown");
    const recovered = fixture({ state: failed.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0].message).toContain("resolved alert");
  });

  it("delivers a new blocker past an uncertain backlog with a rejected recipient", () => {
    const first = fixture({
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-old" }),
        runPhase: () => {
          throw new Error("old blocker");
        },
        sendThread: () => {
          throw new Error("dispatch timed out");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("old blocker");
    const sent = [];
    const second = fixture({
      state: first.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-new" }),
        runPhase: () => {
          throw new Error("new blocker");
        },
        sendThread: (threadId, message) => {
          sent.push({ threadId, message });
          if (threadId === "thread-old")
            throw Object.assign(new Error("rejected"), {
              phase: "alert-delivery",
              diagnostic: "LastCode thread 'thread-old' was not found.",
            });
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("new blocker");
    expect(sent.map((item) => item.threadId)).toEqual(["thread-old", "thread-new"]);
    expect(second.state.incident.alertDelivery).toBe("sent");
    expect(second.state.pendingIncidents).toEqual([
      expect.objectContaining({
        alertDelivery: "unknown",
        deliveryThreadId: "thread-old",
      }),
    ]);
  });

  it("retains an earlier uncertain recipient when a later retry is definitively rejected", () => {
    const runPhase = () => {
      throw new Error("fetch failed");
    };
    const targetRejected = () =>
      Object.assign(new Error("target rejected"), {
        diagnostic: "ThreadSendTargetError: LastCode thread 'thread-original' was not found.",
        phase: "alert-delivery",
      });
    const first = fixture({
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-original" }),
        runPhase,
        sendThread: () => {
          throw new Error("request timed out");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");

    const rejected = fixture({
      state: first.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-stale" }),
        runPhase,
        sendThread: (threadId) => {
          expect(threadId).toBe("thread-original");
          throw targetRejected();
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, rejected.dependencies)).toThrow("fetch failed");
    expect(rejected.state.incident).toMatchObject({
      alertDelivery: "unknown",
      deliveryThreadId: "thread-original",
    });
    expect(rejected.state.incident.attemptedThreadId).toBeUndefined();

    const recovered = fixture({ state: rejected.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toEqual([expect.objectContaining({ threadId: "thread-original" })]);
    expect(recovered.messages[0]?.message).toContain("resolved alert");
  });

  it("delivers every distinct blocker after thread delivery recovers", () => {
    const first = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("first fetch blocker");
        },
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("first fetch blocker");

    const second = fixture({
      state: first.state,
      dependencies: {
        runPhase: () => {
          throw new Error("second fetch blocker");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("second fetch blocker");

    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]?.message).not.toBe(second.messages[1]?.message);
    expect(second.state.pendingIncidents).toBeUndefined();
    expect(second.state.pendingResolutions).toHaveLength(1);
    expect(second.state.incident).toMatchObject({ alertDelivery: "sent" });

    const recovered = fixture({ state: second.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages.every(({ message }) => message.includes("resolved alert"))).toBe(
      true,
    );
    expect(recovered.state.pendingResolutions).toBeUndefined();
  });

  it("closes every delivered blocker after distinct failures recover", () => {
    const first = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("first fetch blocker");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("first fetch blocker");

    const second = fixture({
      state: first.state,
      dependencies: {
        runPhase: () => {
          throw new Error("second fetch blocker");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("second fetch blocker");
    expect(second.state.pendingResolutions).toHaveLength(1);

    const recovered = fixture({ state: second.state });
    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages.every(({ message }) => message.includes("resolved alert"))).toBe(
      true,
    );
    expect(recovered.messages[0]?.message).not.toBe(recovered.messages[1]?.message);
    expect(recovered.state.pendingResolutions).toBeUndefined();
    expect(recovered.state.incident).toMatchObject({ resolutionDelivery: "sent" });
  });

  it("reuses a queued incident when alternating blockers return", () => {
    const failWith = (message) => () => {
      throw new Error(message);
    };
    const first = fixture({ dependencies: { runPhase: failWith("blocker A") } });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("blocker A");

    const second = fixture({
      state: first.state,
      dependencies: { runPhase: failWith("blocker B") },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("blocker B");

    const third = fixture({
      state: second.state,
      dependencies: { runPhase: failWith("blocker A") },
    });
    expect(() => runCheckpointSupervisor({}, third.dependencies)).toThrow("blocker A");
    expect(third.messages).toEqual([]);
    expect(third.state.pendingResolutions).toHaveLength(1);

    const recovered = fixture({ state: third.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages[0]?.message).not.toBe(recovered.messages[1]?.message);
    expect(recovered.state.pendingResolutions).toBeUndefined();
  });

  it("retains an undelivered closure when a later run fails", () => {
    const failed = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("blocker A");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("blocker A");

    const recoveredWithoutDelivery = fixture({
      state: failed.state,
      dependencies: {
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    runCheckpointSupervisor({}, recoveredWithoutDelivery.dependencies);
    expect(recoveredWithoutDelivery.state).toMatchObject({
      status: "success",
      incident: { resolutionDelivery: "pending" },
    });

    const failedAgain = fixture({
      state: recoveredWithoutDelivery.state,
      dependencies: {
        runPhase: () => {
          throw new Error("blocker B");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failedAgain.dependencies)).toThrow("blocker B");
    expect(failedAgain.messages).toHaveLength(1);
    expect(failedAgain.state.pendingResolutions).toHaveLength(1);

    const finallyRecovered = fixture({ state: failedAgain.state });
    runCheckpointSupervisor({}, finallyRecovered.dependencies);
    expect(finallyRecovered.messages).toHaveLength(2);
    expect(
      finallyRecovered.messages.every(({ message }) => message.includes("resolved alert")),
    ).toBe(true);
    expect(finallyRecovered.state.pendingResolutions).toBeUndefined();
  });

  it("reopens recurring incidents when no recovery thread is configured", () => {
    const runPhase = () => {
      throw new Error("fetch failed");
    };
    const first = fixture({
      dependencies: { loadConfig: () => null, runPhase },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");
    expect(first.dependencies.notify).toHaveBeenCalledOnce();

    const recovered = fixture({
      state: first.state,
      dependencies: { loadConfig: () => null },
    });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.state).toMatchObject({
      status: "success",
      incident: { alertDelivery: "not-needed", resolutionDelivery: "not-needed" },
    });
    expect(recovered.state.pendingIncidents).toBeUndefined();

    const recurring = fixture({
      state: recovered.state,
      dependencies: { loadConfig: () => null, runPhase },
    });
    expect(() => runCheckpointSupervisor({}, recurring.dependencies)).toThrow("fetch failed");
    expect(recurring.dependencies.notify).toHaveBeenCalledOnce();
    expect(recurring.state.incident).toMatchObject({ alertDelivery: "pending" });
  });

  it("closes an ambiguous alert at its original recipient after another failure", () => {
    const failed = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("blocker A");
        },
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("blocker A");

    const recoveredWithoutDelivery = fixture({
      state: failed.state,
      dependencies: {
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    runCheckpointSupervisor({}, recoveredWithoutDelivery.dependencies);

    const failedAgain = fixture({
      state: recoveredWithoutDelivery.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-delivery" }),
        runPhase: () => {
          throw new Error("blocker B");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failedAgain.dependencies)).toThrow("blocker B");
    expect(failedAgain.state.pendingResolutions).toHaveLength(1);

    const finallyRecovered = fixture({
      state: failedAgain.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-replacement" }),
      },
    });
    runCheckpointSupervisor({}, finallyRecovered.dependencies);
    expect(finallyRecovered.messages).toHaveLength(2);
    expect(finallyRecovered.messages[0]).toMatchObject({ threadId: "thread-maintenance" });
    expect(finallyRecovered.messages[1]).toMatchObject({ threadId: "thread-delivery" });
    expect(
      finallyRecovered.messages.every(({ message }) => message.includes("resolved alert")),
    ).toBe(true);
  });

  it("sends one closure after a failed incident recovers", () => {
    const previous = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, previous.dependencies)).toThrow("fetch failed");

    const recovered = fixture({ state: previous.state });
    expect(runCheckpointSupervisor({}, recovered.dependencies)).toMatchObject({
      status: "success",
      incident: { resolutionDelivery: "sent" },
    });
    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0]?.message).toContain("maintenance resolved alert");

    const stillHealthy = fixture({ state: recovered.state });
    runCheckpointSupervisor({}, stillHealthy.dependencies);
    expect(stillHealthy.messages).toEqual([]);
  });

  it("sends an incident closure to the thread that received its alert", () => {
    const previous = fixture({
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-original" }),
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, previous.dependencies)).toThrow("fetch failed");
    expect(previous.state.incident).toMatchObject({
      alertDelivery: "sent",
      deliveryThreadId: "thread-original",
    });

    const recovered = fixture({
      state: previous.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-replacement" }),
      },
    });
    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0]).toMatchObject({ threadId: "thread-original" });
    expect(recovered.messages[0]?.message).toContain("maintenance resolved alert");
  });

  it("does not queue backlog closures when recovery occurs with delivery disabled", () => {
    const recovered = fixture({
      state: {
        schemaVersion: 1,
        status: "failed",
        pendingIncidents: [
          {
            fingerprint: "old-blocker",
            alertDelivery: "unknown",
            deliveryThreadId: "thread-old",
            deliveryAttempts: 1,
            failure: { phase: "fetch", error: "old blocker" },
          },
        ],
      },
      dependencies: { loadConfig: () => null },
    });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toEqual([]);
    expect(recovered.state.pendingResolutions ?? []).toEqual([]);
    const enabled = fixture({ state: recovered.state });
    runCheckpointSupervisor({}, enabled.dependencies);
    expect(enabled.messages).toEqual([]);
  });

  it("continues closures past a rejected old recipient while retaining its evidence", () => {
    const sent = [];
    const makeIncident = (fingerprint, deliveryThreadId) => ({
      fingerprint,
      deliveryThreadId,
      alertDelivery: "sent",
      resolutionDelivery: "pending",
      failure: { phase: "fetch", error: "blocker" },
    });
    const recovered = fixture({
      state: {
        schemaVersion: 1,
        status: "failed",
        incident: makeIncident("current", "thread-current"),
        pendingResolutions: [
          makeIncident("old", "thread-old"),
          makeIncident("later", "thread-later"),
        ],
      },
      dependencies: {
        sendThread: (threadId) => {
          sent.push(threadId);
          if (threadId === "thread-old")
            throw Object.assign(new Error("rejected"), {
              phase: "alert-delivery",
              diagnostic: "LastCode thread 'thread-old' was not found.",
            });
        },
      },
    });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(sent).toEqual(["thread-old", "thread-later", "thread-current"]);
    expect(recovered.state.pendingResolutions).toEqual([
      expect.objectContaining({ fingerprint: "old" }),
    ]);
    expect(recovered.state.incident.resolutionDelivery).toBe("sent");
  });

  it("preserves a delivered alert when its recovery destination is removed", () => {
    const failed = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("fetch failed");

    const recovered = fixture({
      state: failed.state,
      dependencies: { loadConfig: () => null },
    });
    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toEqual([]);
    expect(recovered.state.incident).toMatchObject({
      alertDelivery: "sent",
      resolutionDelivery: "not-needed",
    });
  });

  it("does not send a closure for an undelivered incident from prior durable state", () => {
    const incident = {
      alertDelivery: "pending",
      failure: { phase: "fetch", error: "fetch failed" },
      fingerprint: "undelivered-incident",
      resolutionDelivery: "pending",
    };
    const recovered = fixture({
      state: {
        schemaVersion: 1,
        status: "success",
        incident,
        pendingResolutions: [incident],
      },
    });

    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toEqual([]);
    expect(recovered.state.pendingResolutions).toBeUndefined();
    expect(recovered.state.incident).toMatchObject({
      alertDelivery: "not-needed",
      resolutionDelivery: "not-needed",
    });
  });

  it("does not replay or close a legacy attempted alert without its original recipient", () => {
    const incident = {
      alertDelivery: "pending",
      deliveryAttempts: 1,
      failure: { phase: "fetch", error: "fetch failed" },
      fingerprint: "legacy-attempted-incident",
      resolutionDelivery: "pending",
    };
    const recovered = fixture({
      state: {
        schemaVersion: 1,
        status: "success",
        incident,
        pendingIncidents: [incident],
      },
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-replacement" }),
      },
    });

    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toEqual([]);
    expect(recovered.state.pendingIncidents).toEqual([expect.objectContaining(incident)]);
    expect(recovered.state.pendingResolutions).toBeUndefined();
    expect(recovered.state.incident).toMatchObject({
      alertDelivery: "unknown",
      resolutionDelivery: "not-needed",
    });
    const failedLater = fixture({
      state: recovered.state,
      dependencies: {
        runPhase: () => {
          throw new Error("different later failure");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failedLater.dependencies)).toThrow(
      "different later failure",
    );
    expect(failedLater.messages).toHaveLength(1);
    expect(failedLater.messages[0]?.message).not.toContain("legacy-attempted-incident");
  });

  it("closes legacy pending attempts when the original recipient is recorded", () => {
    const test = fixture({
      state: {
        schemaVersion: 1,
        status: "failed",
        incident: {
          alertDelivery: "pending",
          deliveryAttempts: 1,
          deliveryThreadId: "original-thread",
          fingerprint: "legacy-known-recipient",
          failure: { phase: "fetch", error: "fetch failed" },
        },
      },
    });
    runCheckpointSupervisor({}, test.dependencies);
    expect(test.messages).toHaveLength(1);
    expect(test.messages[0]?.threadId).toBe("original-thread");
    expect(test.messages[0]?.message).toContain("maintenance resolved alert");
    expect(test.state.incident.alertDelivery).toBe("pending");
    expect(test.state.incident.resolutionDelivery).toBe("sent");
  });

  it("closes an ambiguous alert instead of replaying it when recovery follows", () => {
    const previous = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, previous.dependencies)).toThrow("fetch failed");

    const recovered = fixture({ state: previous.state });
    expect(runCheckpointSupervisor({}, recovered.dependencies)).toMatchObject({
      status: "success",
      incident: { alertDelivery: "unknown", resolutionDelivery: "sent" },
    });
    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0]?.message).toContain("maintenance resolved alert");
    expect(recovered.state.pendingIncidents).toBeUndefined();
  });

  it("drops every never-attempted queued alert when distinct blockers recover together", () => {
    const failWith = (message) => () => {
      throw new Error(message);
    };
    const first = fixture({
      dependencies: {
        loadConfig: () => null,
        runPhase: failWith("blocker A"),
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("blocker A");

    const second = fixture({
      state: first.state,
      dependencies: {
        loadConfig: () => null,
        runPhase: failWith("blocker B"),
      },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("blocker B");

    const recovered = fixture({ state: second.state });
    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toEqual([]);
    expect(recovered.state.pendingIncidents).toBeUndefined();
    expect(recovered.state.pendingResolutions).toBeUndefined();
    expect(recovered.state.incident).toMatchObject({
      alertDelivery: "not-needed",
      resolutionDelivery: "not-needed",
    });
  });

  it("ignores a malformed durable incident backlog", () => {
    const test = fixture({
      state: { schemaVersion: 1, status: "success", pendingIncidents: "invalid" },
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("fetch failed");
    expect(test.messages).toHaveLength(1);
    expect(test.state).toMatchObject({
      status: "failed",
      incident: { alertDelivery: "sent" },
    });
  });

  it("discards malformed records inside durable incident state", () => {
    const test = fixture({
      state: {
        schemaVersion: 1,
        status: "success",
        pendingIncidents: ["invalid", { fingerprint: "missing-failure" }],
        pendingResolutions: [null, 42],
        incident: "invalid",
      },
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("fetch failed");
    expect(test.messages).toHaveLength(1);
    expect(test.state.pendingIncidents).toBeUndefined();
    expect(test.state.pendingResolutions).toBeUndefined();
    expect(test.state).toMatchObject({
      status: "failed",
      incident: { alertDelivery: "sent" },
    });
  });

  it("does not inherit unrelated or credential-bearing session variables", () => {
    expect(
      checkpointEnvironment(
        {
          HOME: "/wrong",
          PATH: "/wrong",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          ELECTRON_RUN_AS_NODE: "1",
          SECRET_TOKEN: "do-not-copy",
          USER: "example-user",
        },
        "/Users/example",
        "/opt/pinned-node/bin/node",
      ),
    ).toEqual({
      HOME: "/Users/example",
      PATH: "/opt/pinned-node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      USER: "example-user",
    });
  });

  it("keeps recovery instructions bounded and tied to the retained branch", () => {
    const message = checkpointFailureMessage(
      {
        phase: "checkpoint",
        error: "rebase failed",
        checkpointRun: {
          upstreamTag: "nightly-1",
          recoveryBranch: "sync/nightly/nightly-1",
        },
      },
      "abcdef1234567890",
    );
    expect(message).toContain("abcdef123456");
    expect(message).toContain("sync/nightly/nightly-1");
    expect(message).toContain("lastcode-checkpoints --verbose");
    expect(message).toContain("nightly-checkpoint.stderr.log");
  });

  it("distinguishes different recorded checkpoint blockers behind the same wrapper error", () => {
    const baseFailure = {
      phase: "checkpoint",
      error: "node failed with exit code 1",
      checkpointRun: {
        upstreamTag: "nightly-1",
        failurePhase: "smoke",
        recoveryBranch: "sync/nightly/nightly-1",
      },
    };

    expect(
      checkpointIncidentFingerprint({
        ...baseFailure,
        checkpointRun: { ...baseFailure.checkpointRun, error: "migration smoke failed" },
      }),
    ).not.toBe(
      checkpointIncidentFingerprint({
        ...baseFailure,
        checkpointRun: { ...baseFailure.checkpointRun, error: "server typecheck failed" },
      }),
    );
  });

  it("distinguishes pre-checkpoint blockers with the same command exit", () => {
    const baseFailure = {
      phase: "fetch",
      error: "git failed with exit code 128",
      checkpointRun: null,
    };

    expect(
      checkpointIncidentFingerprint({ ...baseFailure, diagnostic: "host key verification failed" }),
    ).not.toBe(
      checkpointIncidentFingerprint({ ...baseFailure, diagnostic: "repository not found" }),
    );
  });

  it("bounds and redacts command diagnostics before persistence or delivery", () => {
    const diagnostic = boundedCommandDiagnostic(
      `https://user:password@example.com/repo token=secret-value github_pat_abcdefghijklmnopqrstuvwxyz ${"x".repeat(2_000)}`,
    );

    expect(diagnostic.length).toBeLessThanOrEqual(1_203);
    expect(diagnostic).not.toContain("user:password");
    expect(diagnostic).not.toContain("secret-value");
    expect(diagnostic).not.toContain("github_pat_");
    expect(diagnostic.endsWith("x".repeat(1_000))).toBe(true);
  });

  it("ignores invalid history shapes while finding the latest valid failure", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-history-"));
    const historyPath = NodePath.join(directory, "checkpoint-runs.jsonl");
    NodeFS.writeFileSync(
      historyPath,
      `${JSON.stringify({ status: "failed", error: "original failure" })}\nnull\n`,
    );

    expect(latestFailedCheckpointRun(historyPath)).toMatchObject({
      status: "failed",
      error: "original failure",
    });
    NodeFS.rmSync(directory, { recursive: true });
  });

  it("preserves and reports the original failure when history enrichment fails", () => {
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun: () => {
          throw new Error("history unreadable");
        },
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("original checkpoint failure");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "original checkpoint failure",
    );
    expect(test.state).toMatchObject({
      status: "failed",
      incident: {
        alertDelivery: "sent",
        failure: { error: "original checkpoint failure", checkpointRun: null },
      },
    });
    expect(test.messages).toHaveLength(1);
  });

  it("does not enrich a checkpoint failure with stale history", () => {
    const stale = {
      status: "failed",
      upstreamTag: "v0.0.35-nightly.stale",
      recoveryBranch: "sync/nightly/v0.0.35-nightly.stale",
      error: "old smoke failure",
    };
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun: () => stale,
        retainedRecoveryMatches: () => false,
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("current planning failure");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "current planning failure",
    );
    expect(test.state.incident.failure).toMatchObject({ checkpointRun: null });
    expect(test.messages[0]?.message).not.toContain("v0.0.35-nightly.stale");
  });

  it("uses a checkpoint history record written by the current invocation", () => {
    const stale = { status: "failed", upstreamTag: "stale", error: "old failure" };
    const current = { status: "failed", upstreamTag: "current", error: "current failure" };
    const latestFailedCheckpointRun = vi
      .fn()
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(current);
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun,
        retainedRecoveryMatches: () => false,
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("checkpoint failed");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("checkpoint failed");
    expect(test.state.incident.failure.checkpointRun).toEqual(current);
  });

  it("uses unchanged history only for the matching retained recovery", () => {
    const retained = {
      status: "failed",
      upstreamTag: "v0.0.35-nightly.retained",
      recoveryBranch: "sync/nightly/v0.0.35-nightly.retained",
      error: "retained smoke failure",
    };
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun: () => retained,
        retainedRecoveryMatches: () => true,
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("retained worktree blocks retry");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "retained worktree blocks retry",
    );
    expect(test.state.incident.failure.checkpointRun).toEqual(retained);
  });

  it("turns corrupt durable state into a reportable supervisor incident", () => {
    const test = fixture({
      dependencies: {
        loadState: () => {
          throw new Error("invalid state json");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("invalid state json");
    expect(test.state).toMatchObject({ status: "failed", phase: "supervisor-state" });
    expect(test.messages).toHaveLength(1);
  });

  it("keeps the installed supervisor until the source version lands", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-supervisor-"));
    const installedPath = NodePath.join(directory, "installed.mjs");
    NodeFS.writeFileSync(installedPath, "installed\n");

    expect(() => refreshInstalledSupervisor(directory, installedPath)).not.toThrow();
    expect(NodeFS.readFileSync(installedPath, "utf8")).toBe("installed\n");

    NodeFS.rmSync(directory, { recursive: true });
  });
});
