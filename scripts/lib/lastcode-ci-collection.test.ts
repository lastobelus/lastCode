import { describe, expect, it } from "vite-plus/test";

import { runCollectedCiSteps, type CiStepResult } from "./lastcode-ci-collection.ts";

class CheckFailure extends Error {}

const isCheckFailure = (error: unknown) => error instanceof CheckFailure;

describe("collected CI steps", () => {
  it("collects two independent failures and a later pass in execution order", async () => {
    const observed: CiStepResult[] = [];
    const executed: string[] = [];
    const results = await runCollectedCiSteps({
      steps: [{ label: "contracts" }, { label: "web" }, { label: "server" }],
      signal: new AbortController().signal,
      isCheckFailure,
      execute: async (step, index) => {
        expect(observed).toHaveLength(index);
        executed.push(step.label);
        if (step.label !== "server") throw new CheckFailure(`${step.label} assertion failed`);
      },
      onResult: (result) => observed.push(result),
    });
    expect(executed).toEqual(["contracts", "web", "server"]);
    expect(results).toEqual(observed);
    expect(results.map(({ label, status, error }) => ({ label, status, error }))).toEqual([
      { label: "contracts", status: "failed", error: "contracts assertion failed" },
      { label: "web", status: "failed", error: "web assertion failed" },
      { label: "server", status: "passed", error: undefined },
    ]);
    expect(results.every(({ durationMs }) => durationMs >= 0)).toBe(true);
  });

  it("does not inspect stale build outputs after a failed or blocked prerequisite", async () => {
    const executed: string[] = [];
    const results = await runCollectedCiSteps({
      steps: [
        { label: "desktop build" },
        { label: "preload assertions", dependsOn: ["desktop build"] },
        { label: "release smoke", dependsOn: ["preload assertions"] },
        { label: "rust tests" },
      ],
      signal: new AbortController().signal,
      isCheckFailure,
      execute: async ({ label }) => {
        executed.push(label);
        if (label === "desktop build") throw new CheckFailure("build failed");
      },
    });
    expect(executed).toEqual(["desktop build", "rust tests"]);
    expect(results[1]).toMatchObject({ status: "blocked", blockedBy: ["desktop build"] });
    expect(results[2]).toMatchObject({ status: "blocked", blockedBy: ["preload assertions"] });
    expect(results[3]?.status).toBe("passed");
  });

  it("stops for unexpected execution or cleanup failures", async () => {
    const unexpected = new Error("could not clean up child process");
    const executed: string[] = [];
    await expect(
      runCollectedCiSteps({
        steps: [{ label: "first" }, { label: "later" }],
        signal: new AbortController().signal,
        isCheckFailure,
        execute: async ({ label }) => {
          executed.push(label);
          throw unexpected;
        },
      }),
    ).rejects.toBe(unexpected);
    expect(executed).toEqual(["first"]);
  });

  it("aborts without reporting success or running later steps even for a collectable failure", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by operator");
    const observed: CiStepResult[] = [];
    const executed: string[] = [];
    await expect(
      runCollectedCiSteps({
        steps: [{ label: "first" }, { label: "later" }],
        signal: controller.signal,
        isCheckFailure,
        execute: async ({ label }) => {
          executed.push(label);
          controller.abort(reason);
          throw new CheckFailure("interrupted check");
        },
        onResult: (result) => observed.push(result),
      }),
    ).rejects.toBe(reason);
    expect(executed).toEqual(["first"]);
    expect(observed).toEqual([]);
  });

  it("blocks missing and later prerequisites without running their dependent", async () => {
    const executed: string[] = [];
    const results = await runCollectedCiSteps({
      steps: [
        { label: "missing prerequisite", dependsOn: ["not planned"] },
        { label: "premature consumer", dependsOn: ["producer"] },
        { label: "producer" },
      ],
      signal: new AbortController().signal,
      isCheckFailure,
      execute: async ({ label }) => {
        executed.push(label);
      },
    });
    expect(executed).toEqual(["producer"]);
    expect(results[0]).toMatchObject({ status: "blocked", blockedBy: ["not planned"] });
    expect(results[1]).toMatchObject({ status: "blocked", blockedBy: ["producer"] });
  });

  it("propagates result publication failures instead of continuing silently", async () => {
    const failure = new Error("could not write inventory");
    const executed: string[] = [];
    await expect(
      runCollectedCiSteps({
        steps: [{ label: "first" }, { label: "later" }],
        signal: new AbortController().signal,
        isCheckFailure,
        execute: async ({ label }) => {
          executed.push(label);
        },
        onResult: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(executed).toEqual(["first"]);
  });
});
