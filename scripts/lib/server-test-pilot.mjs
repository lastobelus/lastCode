import * as NodeAssert from "node:assert/strict";

const transferTest = "integration/transferBudgetV2.integration.test.ts";

export function assertPilotRuntime(version) {
  NodeAssert.equal(version, "v24.13.1", "Pilot requires checkpoint Node v24.13.1");
}

function strictFingerprint({ cpu: _cpu, ...identity }) {
  return identity;
}

function unique(files) {
  NodeAssert.ok(Array.isArray(files) && files.length > 0, "Empty discovery/results");
  NodeAssert.equal(new Set(files).size, files.length, "Duplicate test file");
  return [...files].sort();
}

// Advisory evidence only. This deliberately has no connection to Full CI stamps.
export function validatePilot(receipts) {
  NodeAssert.equal(receipts.length, 3, "Need baseline and both shard results");
  const byCohort = new Map(receipts.map((receipt) => [receipt.cohort, receipt]));
  NodeAssert.equal(byCohort.size, 3, "Duplicate cohort");
  const baseline = byCohort.get("baseline");
  NodeAssert.ok(baseline, "Missing baseline");
  const shards = [byCohort.get("1"), byCohort.get("2")];
  NodeAssert.ok(shards.every(Boolean), "Missing shard");
  for (const receipt of receipts) {
    NodeAssert.equal(receipt.exitCode, 0, "Failed/cancelled worker");
    NodeAssert.equal(receipt.success, true, "Incomplete test run");
    assertPilotRuntime(receipt.fingerprint.node);
    assertPilotRuntime(receipt.fingerprint.testNode);
    NodeAssert.ok(
      typeof receipt.fingerprint.cpu === "string" && receipt.fingerprint.cpu.length > 0,
      "Missing CPU model",
    );
    NodeAssert.ok(
      Number.isSafeInteger(receipt.fingerprint.cpus) && receipt.fingerprint.cpus > 0,
      "Invalid CPU allocation",
    );
    NodeAssert.ok(
      Number.isFinite(receipt.fingerprint.memoryGiB) && receipt.fingerprint.memoryGiB > 0,
      "Invalid memory allocation",
    );
    NodeAssert.deepEqual(
      strictFingerprint(receipt.fingerprint),
      strictFingerprint(baseline.fingerprint),
      "Candidate/runtime/config mismatch",
    );
    NodeAssert.deepEqual(
      unique(receipt.discovery),
      unique(baseline.discovery),
      "Discovery mismatch",
    );
    NodeAssert.deepEqual(
      unique(receipt.selected),
      unique(receipt.executed),
      "Missing/unexpected results",
    );
    NodeAssert.ok(
      Number.isFinite(receipt.durationMs) && receipt.durationMs > 0,
      "Invalid duration",
    );
    NodeAssert.ok(
      Number.isFinite(receipt.startedAt) &&
        Number.isFinite(receipt.endedAt) &&
        receipt.endedAt >= receipt.startedAt,
      "Invalid worker interval",
    );
    NodeAssert.equal(
      receipt.transferProduced,
      receipt.selected.includes(transferTest),
      "Missing/unexpected transfer output",
    );
  }
  NodeAssert.equal(
    new Set(receipts.map((receipt) => receipt.machine)).size,
    3,
    "Workers must use separate machines",
  );
  NodeAssert.deepEqual(
    unique(baseline.selected),
    unique(baseline.discovery),
    "Incomplete baseline",
  );
  const union = shards.flatMap((receipt) => receipt.selected);
  NodeAssert.deepEqual(
    unique(union),
    unique(baseline.discovery),
    "Shard union differs from complete discovery",
  );
  const matchingCpuModels = new Set(receipts.map((receipt) => receipt.fingerprint.cpu)).size === 1;
  return {
    advisoryOnly: true,
    protocolStatus: "complete",
    timingComparison: {
      status: matchingCpuModels ? "comparable" : "inconclusive",
      reason: matchingCpuModels ? "matching-recorded-hardware" : "cpu-model-mismatch",
      qualification:
        "Single hosted Linux observation; no whole-checkpoint or publication guarantee.",
    },
    hardware: receipts.map(({ cohort, fingerprint }) => ({
      cohort,
      cpu: fingerprint.cpu,
      cpus: fingerprint.cpus,
      memoryGiB: fingerprint.memoryGiB,
      platform: fingerprint.platform,
      arch: fingerprint.arch,
      image: fingerprint.image,
      imageVersion: fingerprint.imageVersion,
    })),
    runtime: { driver: baseline.fingerprint.node, test: baseline.fingerprint.testNode },
    candidate: baseline.fingerprint.candidate,
    files: baseline.discovery.length,
    baselineMs: baseline.durationMs,
    shardMs: shards.map((receipt) => receipt.durationMs),
    shardCriticalPathMs: Math.max(...shards.map((receipt) => receipt.durationMs)),
    // Includes scheduling skew; it is not the sum of isolated worker durations.
    shardSpanMs:
      Math.max(...shards.map((receipt) => receipt.endedAt)) -
      Math.min(...shards.map((receipt) => receipt.startedAt)),
  };
}
