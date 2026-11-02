import * as NodeAssert from "node:assert/strict";
import { it } from "vite-plus/test";
import { validatePilot } from "./server-test-pilot.mjs";

const transfer = "integration/transferBudgetV2.integration.test.ts";
function fixture() {
  const discovery = ["src/a.test.ts", transfer];
  return ["baseline", "1", "2"].map((cohort) => {
    const selected = cohort === "baseline" ? discovery : [discovery[Number(cohort) - 1]];
    return {
      cohort,
      fingerprint: {
        candidate: "candidate",
        node: "v24.13.1",
        testNode: "v24.13.1",
        cpu: "CPU family A",
        cpus: 4,
        memoryGiB: 16,
        tree: "tree",
        lock: "lock",
        vp: "vp-version",
        image: "ubuntu",
        imageVersion: "image-version",
      },
      machine: cohort,
      discovery,
      selected,
      executed: [...selected],
      exitCode: 0,
      success: true,
      transferProduced: selected.includes(transfer),
      durationMs: 100,
      startedAt: 100,
      endedAt: 200,
    };
  });
}

it("accepts complete disjoint cohorts and rejects unusable benchmark evidence", () => {
  NodeAssert.equal(validatePilot(fixture()).files, 2);
  const differentCpu = fixture();
  differentCpu[1].fingerprint.cpu = "CPU family B";
  const inconclusive = validatePilot(differentCpu);
  NodeAssert.equal(inconclusive.protocolStatus, "complete");
  NodeAssert.equal(inconclusive.timingComparison.status, "inconclusive");
  NodeAssert.equal(inconclusive.timingComparison.reason, "cpu-model-mismatch");
  NodeAssert.deepEqual(
    inconclusive.hardware.map((worker) => worker.cpu),
    ["CPU family A", "CPU family B", "CPU family A"],
  );
  NodeAssert.equal(Object.hasOwn(inconclusive, "speedup"), false);
  NodeAssert.equal(validatePilot(fixture()).timingComparison.status, "comparable");
  const mutations = [
    (r) => r.pop(),
    (r) => {
      r[2] = structuredClone(r[1]);
    },
    (r) => {
      r[2].selected = [...r[1].selected];
      r[2].executed = [...r[1].executed];
      r[2].transferProduced = false;
    },
    (r) => {
      r[1].executed = [];
    },
    (r) => {
      r[1].fingerprint.candidate = "other";
    },
    (r) => {
      r[1].fingerprint.node = "other";
    },
    (r) => {
      r[1].fingerprint.cpus = 8;
    },
    (r) => {
      r[1].fingerprint.memoryGiB = 32;
    },
    ...["testNode", "tree", "lock", "vp", "image", "imageVersion"].map((field) => (r) => {
      r[1].fingerprint[field] = "other";
    }),
    (r) => {
      for (const receipt of r) receipt.fingerprint.node = receipt.fingerprint.testNode = "v26.12.1";
    },
    (r) => {
      r[1].discovery = ["other"];
    },
    (r) => {
      r[1].exitCode = 1;
    },
    (r) => {
      r[1].exitCode = null;
    },
    (r) => {
      r[1].success = false;
    },
    (r) => {
      r[1].machine = r[2].machine;
    },
    (r) => {
      r[2].transferProduced = false;
    },
    (r) => {
      r[0].selected = r[1].selected;
      r[0].executed = r[1].executed;
      r[0].transferProduced = false;
    },
  ];
  for (const mutate of mutations) {
    const receipts = fixture();
    mutate(receipts);
    NodeAssert.throws(() => validatePilot(receipts));
  }
});
