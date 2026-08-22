import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  SimulatedActivationCrash,
  deriveActivationPaths,
  makeActivationJournalStore,
  prepareActivationJournal,
  runActivationTransaction,
  selectSupportedOwner,
  validateTrialPlist,
} from "./lastcode-activation-helper.mjs";

const REQUEST_ID = "request-38-e2a-lite";
const TARGET_DIGEST = "a".repeat(64);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function write(path, contents) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
}

function read(path) {
  return NodeFS.readFileSync(path, "utf8");
}

function validateFixtureTrialPlist(journal) {
  const values = {
    Label: "codes.lastobelus.lastcode.server",
    "EnvironmentVariables:LASTCODE_ACTIVATION_MODE": "trial",
    "EnvironmentVariables:LASTCODE_ACTIVATION_REQUEST_ID": journal.requestId,
    "EnvironmentVariables:LASTCODE_ACTIVATION_TARGET_DIGEST": journal.targetDigest,
  };
  validateTrialPlist(journal, (_path, key) => values[key]);
}

function createFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-activation-lite-"));
  temporaryDirectories.push(root);
  const homeDir = NodePath.join(root, "home");
  const applicationsDir = NodePath.join(root, "Applications");
  const paths = deriveActivationPaths({ homeDir, applicationsDir, requestId: REQUEST_ID });
  write(NodePath.join(paths.liveAppPath, "selection.txt"), "prior-app");
  write(NodePath.join(paths.candidateAppPath, "selection.txt"), "candidate-app");
  write(paths.livePlistPath, "prior-plist");
  write(paths.candidatePlistPath, "candidate-trial-plist");
  write(paths.databasePath, "prior-db");
  write(`${paths.databasePath}-wal`, "prior-wal");
  write(`${paths.databasePath}-shm`, "prior-shm");
  const journal = prepareActivationJournal(
    {
      homeDir,
      applicationsDir,
      expectedApplicationsDir: applicationsDir,
      requestId: REQUEST_ID,
      targetDigest: TARGET_DIGEST,
      uid: 501,
    },
    { validateTrialPlist: validateFixtureTrialPlist },
  );
  return { applicationsDir, journal, paths };
}

function commitRecord(journal, overrides = {}) {
  write(
    journal.paths.commitRecordPath,
    `${JSON.stringify({
      schemaVersion: 1,
      requestId: journal.requestId,
      targetDigest: journal.targetDigest,
      status: "committed",
      ...overrides,
    })}\n`,
  );
}

function makeExecutor(options = {}) {
  const calls = {
    assertOwner: 0,
    acquireLease: 0,
    startCandidate: 0,
    startPrior: 0,
    stop: 0,
  };
  let service = "prior";
  return {
    calls,
    get service() {
      return service;
    },
    executor: {
      assertSupportedOwner: async () => {
        calls.assertOwner += 1;
        if (options.owner !== undefined) selectSupportedOwner(options.owner);
      },
      stopService: async (journal) => {
        calls.stop += 1;
        service = null;
        options.onStop?.(journal, calls.stop);
      },
      acquireLease: async () => {
        calls.acquireLease += 1;
        if (service !== null) throw new Error("lease is held");
        return () => undefined;
      },
      startCandidateTrial: async (journal) => {
        calls.startCandidate += 1;
        if (service === "candidate") return;
        service = "candidate";
        options.onCandidateStart?.(journal);
      },
      startPriorService: async () => {
        calls.startPrior += 1;
        service = "prior";
      },
    },
  };
}

function run(fixture, fake, options = {}) {
  return runActivationTransaction({
    journalPath: fixture.journal.paths.journalPath,
    expectedApplicationsDir: fixture.applicationsDir,
    executor: fake.executor,
    acquireTransactionLock: () => () => undefined,
    timeoutMs: 0,
    validateTrialPlist: validateFixtureTrialPlist,
    ...options,
  });
}

function expectPriorSelection(paths) {
  expect(read(NodePath.join(paths.liveAppPath, "selection.txt"))).toBe("prior-app");
  expect(read(paths.livePlistPath)).toBe("prior-plist");
}

function expectCandidateSelection(paths) {
  expect(read(NodePath.join(paths.liveAppPath, "selection.txt"))).toBe("candidate-app");
  expect(read(paths.livePlistPath)).toBe("candidate-trial-plist");
}

describe("LastCode one-owner activation helper", () => {
  it("commits one exact candidate and removes the prior selection", async () => {
    const fixture = createFixture();
    const fake = makeExecutor({ onCandidateStart: (journal) => commitRecord(journal) });

    const result = await run(fixture, fake);

    expect(result.state).toBe("committed");
    expectCandidateSelection(fixture.paths);
    expect(NodeFS.existsSync(fixture.paths.previousAppPath)).toBe(false);
    expect(NodeFS.existsSync(fixture.paths.previousPlistPath)).toBe(false);
    expect(fake.service).toBe("candidate");
  });

  it("rejects a commit for the wrong target and restores the prior selection", async () => {
    const fixture = createFixture();
    const fake = makeExecutor({
      onCandidateStart: (journal) => commitRecord(journal, { targetDigest: "b".repeat(64) }),
    });

    const result = await run(fixture, fake);

    expect(result.state).toBe("rolled-back");
    expect(result.rollbackReason).toContain("does not exactly match");
    expectPriorSelection(fixture.paths);
    expect(fake.service).toBe("prior");
  });

  it("rolls back after a bounded commit timeout", async () => {
    const fixture = createFixture();
    const fake = makeExecutor();

    const result = await run(fixture, fake);

    expect(result.state).toBe("rolled-back");
    expect(result.rollbackReason).toContain("Timed out");
    expectPriorSelection(fixture.paths);
    expect(fake.calls.startPrior).toBe(1);

    const edgeFixture = createFixture();
    const edgeFake = makeExecutor({
      onStop: (journal, invocation) => {
        if (invocation === 2) commitRecord(journal);
      },
    });

    const edgeResult = await run(edgeFixture, edgeFake);

    expect(edgeResult.state).toBe("committed");
    expectCandidateSelection(edgeFixture.paths);
    expect(edgeFake.service).toBe("candidate");
  });

  it("rolls back an uncertain restart after the app and plist swap", async () => {
    const fixture = createFixture();
    const fake = makeExecutor();

    await expect(
      run(fixture, fake, {
        hooks: { afterSwap: () => Promise.reject(new SimulatedActivationCrash("swap")) },
      }),
    ).rejects.toThrow("Simulated activation crash");
    expectCandidateSelection(fixture.paths);
    expect(makeActivationJournalStore(fixture.paths.journalPath).read().state).toBe("backup-ready");

    const recovered = await run(fixture, fake);

    expect(recovered.state).toBe("rolled-back");
    expectPriorSelection(fixture.paths);
    expect(fake.service).toBe("prior");
  });

  it("finishes forward after a crash leaves an exact external commit", async () => {
    const fixture = createFixture();
    const fake = makeExecutor({ onCandidateStart: (journal) => commitRecord(journal) });

    await expect(
      run(fixture, fake, {
        hooks: {
          afterCommitObserved: () => Promise.reject(new SimulatedActivationCrash("commit")),
        },
      }),
    ).rejects.toThrow("Simulated activation crash");
    expect(makeActivationJournalStore(fixture.paths.journalPath).read().state).toBe("committed");
    expect(NodeFS.existsSync(fixture.paths.previousAppPath)).toBe(true);
    expect(NodeFS.existsSync(fixture.paths.previousPlistPath)).toBe(true);

    const recovered = await run(fixture, fake);

    expect(recovered.state).toBe("committed");
    expectCandidateSelection(fixture.paths);
    expect(fake.service).toBe("candidate");

    const writeFailureFixture = createFixture();
    const writeFailureFake = makeExecutor({
      onCandidateStart: (journal) => commitRecord(journal),
    });
    const fileStore = makeActivationJournalStore(writeFailureFixture.paths.journalPath, {
      applicationsDir: writeFailureFixture.applicationsDir,
    });
    let failCommittedWrite = true;
    const store = {
      read: fileStore.read,
      write: (journal) => {
        if (journal.state === "committed" && failCommittedWrite) {
          failCommittedWrite = false;
          throw new Error("journal-failure-after-exact-commit");
        }
        fileStore.write(journal);
      },
    };

    await expect(run(writeFailureFixture, writeFailureFake, { store })).rejects.toThrow(
      "journal-failure-after-exact-commit",
    );
    expect(fileStore.read().state).toBe("trial");
    expect((await run(writeFailureFixture, writeFailureFake, { store })).state).toBe("committed");
    expectCandidateSelection(writeFailureFixture.paths);
  });

  it("rejects a live retry until the running helper releases activation ownership", async () => {
    const fixture = createFixture();
    const fake = makeExecutor();
    let locked = false;
    let releases = 0;
    const acquireTransactionLock = () => {
      if (locked) throw new Error("Another LastCode update activation is already running.");
      locked = true;
      return () => {
        locked = false;
        releases += 1;
      };
    };
    let resumePoll;
    const pollRelease = new Promise((resolve) => {
      resumePoll = resolve;
    });
    let markWaiting;
    const waiting = new Promise((resolve) => {
      markWaiting = resolve;
    });
    const first = run(fixture, fake, {
      acquireTransactionLock,
      now: () => 0,
      pollMs: 1,
      timeoutMs: 100,
      wait: () => {
        markWaiting();
        return pollRelease;
      },
    });
    await waiting;

    await expect(run(fixture, fake, { acquireTransactionLock })).rejects.toThrow(
      "Another LastCode update activation is already running.",
    );
    expect(makeActivationJournalStore(fixture.paths.journalPath).read().state).toBe("trial");
    expect(fake.calls.stop).toBe(1);

    commitRecord(fixture.journal);
    resumePoll();
    expect((await first).state).toBe("committed");
    expect(releases).toBe(1);
    expectCandidateSelection(fixture.paths);
  });

  it("re-reads a terminal journal after waiting for activation ownership", async () => {
    const fixture = createFixture();
    const fake = makeExecutor();
    const fileStore = makeActivationJournalStore(fixture.paths.journalPath, {
      applicationsDir: fixture.applicationsDir,
    });
    fileStore.write({
      ...fileStore.read(),
      attempted: true,
      state: "trial",
      updatedAt: new Date().toISOString(),
    });
    let reads = 0;
    const store = {
      read: () => {
        const journal = fileStore.read();
        reads += 1;
        if (reads === 1) {
          fileStore.write({
            ...journal,
            state: "rolled-back",
            rollbackReason: "The active helper completed rollback.",
            updatedAt: new Date().toISOString(),
          });
        }
        return journal;
      },
      write: fileStore.write,
    };

    const result = await run(fixture, fake, { store });

    expect(result.state).toBe("rolled-back");
    expect(reads).toBe(2);
    expect(fake.calls.stop).toBe(0);
    expect(fake.calls.startPrior).toBe(0);
  });

  it("restores the SQLite main file and both sidecars", async () => {
    const fixture = createFixture();
    const fake = makeExecutor({
      onCandidateStart: (journal) => {
        write(journal.paths.databasePath, "candidate-db");
        write(`${journal.paths.databasePath}-wal`, "candidate-wal");
        NodeFS.rmSync(`${journal.paths.databasePath}-shm`);
      },
    });

    const result = await run(fixture, fake);

    expect(result.state).toBe("rolled-back");
    expect(read(fixture.paths.databasePath)).toBe("prior-db");
    expect(read(`${fixture.paths.databasePath}-wal`)).toBe("prior-wal");
    expect(read(`${fixture.paths.databasePath}-shm`)).toBe("prior-shm");
  });

  it("rejects desktop, dual, and missing owners before shutdown", async () => {
    const unsupported = [
      { desktopRunning: true, launchAgentLoaded: false, leaseHeld: true },
      { desktopRunning: true, launchAgentLoaded: true, leaseHeld: true },
      { desktopRunning: false, launchAgentLoaded: false, leaseHeld: false },
    ];
    for (const owner of unsupported) {
      const fixture = createFixture();
      const fake = makeExecutor({ owner });

      await expect(run(fixture, fake)).rejects.toThrow(/owns|owner|LaunchAgent/u);
      expect(fake.calls.stop).toBe(0);
      expect(makeActivationJournalStore(fixture.paths.journalPath).read()).toMatchObject({
        attempted: false,
        state: "prepared",
      });
    }
  });

  it("retries committed and rolled-back journals without repeating service changes", async () => {
    const committedFixture = createFixture();
    const committedFake = makeExecutor({ onCandidateStart: (journal) => commitRecord(journal) });
    await run(committedFixture, committedFake);
    const committedCalls = { ...committedFake.calls };

    expect((await run(committedFixture, committedFake)).state).toBe("committed");
    expect(committedFake.calls).toEqual(committedCalls);

    const rolledBackFixture = createFixture();
    const rolledBackFake = makeExecutor();
    await run(rolledBackFixture, rolledBackFake);
    const rolledBackCalls = { ...rolledBackFake.calls };

    expect((await run(rolledBackFixture, rolledBackFake)).state).toBe("rolled-back");
    expect(rolledBackFake.calls).toEqual(rolledBackCalls);
  });
});
