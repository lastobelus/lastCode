import { describe, expect, it } from "vite-plus/test";

import {
  findCorrelatedRun,
  parseRemoteInstallableRefs,
  parseIntelBuildOptions,
  runSelectedIntelBuild,
  selectIntelBuild,
  type BuildIntelDependencies,
  type BuildRequest,
  type WorkflowRun,
  validateInstallableTag,
  workflowRunName,
} from "./lastcode-build-intel-package.ts";

const tag = "lastcode/revision/v0.0.34-nightly.20260825.1185.3";
const commit = "a".repeat(40);

const request = (overrides: Partial<BuildRequest> = {}): BuildRequest => ({
  schemaVersion: 1,
  installableTag: tag,
  installableCommit: commit,
  requestToken: "intel-12345678-1234-1234-1234-123456789abc",
  selectedAt: "2026-08-27T00:00:00.000Z",
  dispatchAttemptedAt: null,
  workflowRunId: null,
  ...overrides,
});

const workflowRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  databaseId: 123,
  displayTitle: workflowRunName(request()),
  status: "queued",
  conclusion: null,
  url: "https://github.com/lastobelus/lastCode/actions/runs/123",
  headSha: "b".repeat(40),
  createdAt: "2026-08-27T00:01:00.000Z",
  ...overrides,
});

function harness(input: {
  readonly initialRequest?: BuildRequest;
  readonly listedRuns?: ReadonlyArray<ReadonlyArray<WorkflowRun>>;
  readonly viewedRuns?: ReadonlyArray<WorkflowRun>;
  readonly workflowError?: Error;
}) {
  let currentRequest = input.initialRequest ?? request();
  let now = 0;
  let listIndex = 0;
  let viewIndex = 0;
  const calls: string[] = [];
  const listedRuns = input.listedRuns ?? [[workflowRun()]];
  const viewedRuns = input.viewedRuns ?? [
    workflowRun({ status: "completed", conclusion: "success" }),
  ];
  const dependencies: BuildIntelDependencies = {
    now: () => now,
    nowIso: () => "2026-08-27T00:02:00.000Z",
    sleep: async (milliseconds) => {
      calls.push(`sleep:${milliseconds}`);
      now += milliseconds;
    },
    verifyWorkflow: () => {
      calls.push("verify");
      if (input.workflowError) throw input.workflowError;
    },
    dispatchWorkflow: (selected) => calls.push(`dispatch:${selected.requestToken}`),
    listWorkflowRuns: () => {
      calls.push("list");
      const result = listedRuns[Math.min(listIndex, listedRuns.length - 1)] ?? [];
      listIndex += 1;
      return result;
    },
    readWorkflowRun: () => {
      calls.push("view");
      const result = viewedRuns[Math.min(viewIndex, viewedRuns.length - 1)];
      viewIndex += 1;
      if (!result) throw new Error("missing viewed run fixture");
      return result;
    },
    readRelease: (releaseTag) => {
      calls.push(`release:${releaseTag}`);
      return {
        tagName: releaseTag,
        url: `https://github.com/lastobelus/lastCode/releases/tag/${releaseTag}`,
        isDraft: false,
        isImmutable: true,
        isPrerelease: true,
        assets: [{ name: "LastCode-x64.dmg" }, { name: "build-manifest.json" }],
      };
    },
    readRequest: () => currentRequest,
    writeRequest: (next) => {
      calls.push("write");
      currentRequest = next;
    },
    removeRequest: (token) => calls.push(`remove:${token}`),
    withRequestLock: (operation) => {
      calls.push("lock:enter");
      try {
        return operation();
      } finally {
        calls.push("lock:exit");
      }
    },
    log: (message) => calls.push(`log:${message}`),
    registrationTimeoutMs: 20,
    registrationPollMs: 5,
    runTimeoutMs: 30,
    runPollMs: 10,
  };
  return { calls, dependencies, getRequest: () => currentRequest };
}

describe("lastcode-build-intel-package", () => {
  it("accepts only exact checkpoint and revision tags", () => {
    expect(validateInstallableTag(tag)).toBe(tag);
    expect(validateInstallableTag("lastcode/checkpoint/v0.0.34-nightly.20260825.1185")).toBe(
      "lastcode/checkpoint/v0.0.34-nightly.20260825.1185",
    );
    for (const invalid of [
      "v0.0.34-nightly.20260825.1185.3",
      "lastcode/build/v0.0.34-nightly.20260825.1185.3",
      "lastcode/revision/v0.0.34-nightly.latest",
    ]) {
      expect(() => validateInstallableTag(invalid)).toThrow("exact lastcode/checkpoint");
    }
  });

  it("requires an explicit select or run command", () => {
    expect(parseIntelBuildOptions(["select", "--tag", tag])).toEqual({ command: "select", tag });
    expect(parseIntelBuildOptions(["run"])).toEqual({ command: "run" });
    expect(() => parseIntelBuildOptions([])).toThrow("Usage:");
    expect(() => parseIntelBuildOptions(["select", tag])).toThrow("Usage:");
  });

  it("resolves annotated and lightweight remote tags to their exact commits", () => {
    const tagObject = "b".repeat(40);
    expect(
      parseRemoteInstallableRefs(
        tag,
        "origin",
        `${tagObject}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n`,
      ),
    ).toEqual({ tag, commit });
    expect(parseRemoteInstallableRefs(tag, "origin", `${commit}\trefs/tags/${tag}\n`)).toEqual({
      tag,
      commit,
    });
    expect(() => parseRemoteInstallableRefs(tag, "origin", "")).toThrow(
      `does not advertise ${tag}`,
    );
    expect(() =>
      parseRemoteInstallableRefs(tag, "origin", `not-a-sha\trefs/tags/${tag}\n`),
    ).toThrow("invalid metadata");
  });

  it("records the agent-selected remote identity and unique token", () => {
    let written: BuildRequest | null = null;
    const selected = selectIntelBuild(tag, {
      resolveTag: (candidate) => ({ tag: candidate, commit }),
      writeRequest: (value) => {
        written = value;
      },
      nowIso: () => "2026-08-27T00:00:00.000Z",
      uuid: () => "12345678-1234-1234-1234-123456789abc",
    });
    expect(selected).toEqual(request());
    expect(written).toEqual(selected);
  });

  it("correlates only the exact request-token run", () => {
    const other = workflowRun({
      databaseId: 456,
      displayTitle: workflowRunName(
        request({ requestToken: "intel-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
      ),
    });
    expect(findCorrelatedRun(request(), [other, workflowRun()])?.databaseId).toBe(123);
    expect(findCorrelatedRun(request(), [other])).toBeNull();
    expect(() =>
      findCorrelatedRun(request(), [workflowRun(), workflowRun({ databaseId: 124 })]),
    ).toThrow("More than one workflow run");
  });

  it("dispatches once, waits for registration and completion, then reports the release", async () => {
    const test = harness({
      listedRuns: [[], [], [workflowRun()]],
      viewedRuns: [
        workflowRun({ status: "in_progress" }),
        workflowRun({ status: "completed", conclusion: "success" }),
      ],
    });
    const result = await runSelectedIntelBuild(test.dependencies);
    expect(test.calls.filter((call) => call.startsWith("dispatch:"))).toHaveLength(1);
    expect(test.calls.indexOf("lock:enter")).toBeLessThan(test.calls.indexOf("write"));
    expect(test.calls.indexOf("lock:exit")).toBeGreaterThan(
      test.calls.findIndex((call) => call.startsWith("dispatch:")),
    );
    expect(test.getRequest().dispatchAttemptedAt).toBe("2026-08-27T00:02:00.000Z");
    expect(test.getRequest().workflowRunId).toBe(123);
    expect(result).toMatchObject({ tag, commit, runId: 123 });
    expect(result.assets).toEqual(["LastCode-x64.dmg", "build-manifest.json"]);
    expect(test.calls.at(-1)).toBe(`remove:${request().requestToken}`);
  });

  it("reattaches to an already attempted request without dispatching again", async () => {
    const test = harness({
      initialRequest: request({ dispatchAttemptedAt: "2026-08-27T00:01:00.000Z" }),
      listedRuns: [[], [workflowRun({ status: "completed", conclusion: "success" })]],
    });
    await runSelectedIntelBuild(test.dependencies);
    expect(test.calls.some((call) => call.startsWith("dispatch:"))).toBe(false);
  });

  it("reattaches directly to a stored run id without relying on the recent-run listing", async () => {
    const test = harness({
      initialRequest: request({
        dispatchAttemptedAt: "2026-08-27T00:01:00.000Z",
        workflowRunId: 123,
      }),
      listedRuns: [[]],
      viewedRuns: [workflowRun({ status: "completed", conclusion: "success" })],
    });
    await runSelectedIntelBuild(test.dependencies);
    expect(test.calls).not.toContain("list");
    expect(test.calls.some((call) => call.startsWith("dispatch:"))).toBe(false);
  });

  it("waits for token registration after an uncertain dispatch error without dispatching twice", async () => {
    const test = harness({
      listedRuns: [[], [workflowRun({ status: "completed", conclusion: "success" })]],
    });
    const originalDispatch = test.dependencies.dispatchWorkflow;
    const dependencies: BuildIntelDependencies = {
      ...test.dependencies,
      dispatchWorkflow: (selected) => {
        originalDispatch(selected);
        throw new Error("transport closed before response");
      },
    };
    await runSelectedIntelBuild(dependencies);
    expect(test.calls.filter((call) => call.startsWith("dispatch:"))).toHaveLength(1);
    expect(test.calls.some((call) => call.includes("waiting for request-token registration"))).toBe(
      true,
    );
  });

  it("returns configuration, registration, failure, and cancellation as terminal errors", async () => {
    await expect(
      runSelectedIntelBuild(
        harness({ workflowError: new Error("workflow disabled") }).dependencies,
      ),
    ).rejects.toThrow("workflow disabled");

    const registration = harness({ listedRuns: [[]] });
    await expect(runSelectedIntelBuild(registration.dependencies)).rejects.toThrow(
      "did not register workflow request",
    );
    expect(registration.calls.filter((call) => call.startsWith("dispatch:"))).toHaveLength(1);

    for (const conclusion of ["failure", "cancelled"]) {
      const terminal = harness({
        listedRuns: [[workflowRun({ status: "completed", conclusion })]],
      });
      await expect(runSelectedIntelBuild(terminal.dependencies)).rejects.toThrow(
        `ended with ${conclusion}`,
      );
      expect(terminal.calls.at(-1)).toBe(`remove:${request().requestToken}`);
    }
  });
});
