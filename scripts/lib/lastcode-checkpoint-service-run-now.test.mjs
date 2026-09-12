import { describe, expect, it, vi } from "vite-plus/test";

import {
  checkpointServiceRunNowArguments,
  checkpointServiceRunNowPaths,
  requestCheckpointServiceRunNow,
} from "./lastcode-checkpoint-service-run-now.mjs";

const homeDirectory = "/Users/example";
const paths = checkpointServiceRunNowPaths(homeDirectory);

function dependencies(plist) {
  return {
    exists: vi.fn(() => plist !== null),
    now: () => new Date("2026-09-11T12:34:56.000Z"),
    readFile: vi.fn(() => plist ?? ""),
    runLaunchctl: vi.fn(),
    writeRequest: vi.fn(),
  };
}

describe("checkpoint service run-now request", () => {
  it("is a no-op when the service is not installed", () => {
    const deps = dependencies(null);
    expect(requestCheckpointServiceRunNow({ homeDirectory, uid: 501 }, deps)).toEqual({
      status: "not-installed",
    });
    expect(deps.runLaunchctl).not.toHaveBeenCalled();
  });

  it("requests an interval service without replacing an active process", () => {
    const deps = dependencies("<string>lastcode-checkpoint-supervisor.mjs</string>");
    expect(requestCheckpointServiceRunNow({ homeDirectory, uid: 501 }, deps)).toEqual({
      status: "requested",
    });
    expect(deps.writeRequest).not.toHaveBeenCalled();
    expect(deps.runLaunchctl).toHaveBeenCalledWith(
      checkpointServiceRunNowArguments("gui/501/codes.lastobelus.lastcode-nightly-checkpoint"),
    );
    expect(deps.runLaunchctl.mock.calls[0]?.[0]).not.toContain("-k");
  });

  it("marks an explicit daily request before kickstarting the scheduler", () => {
    const deps = dependencies("<string>lastcode-checkpoint-schedule.mjs</string>");
    requestCheckpointServiceRunNow({ homeDirectory, uid: 501 }, deps);
    expect(deps.writeRequest).toHaveBeenCalledWith(paths.requestPath, {
      requestedAt: "2026-09-11T12:34:56.000Z",
    });
    expect(deps.writeRequest.mock.invocationCallOrder[0]).toBeLessThan(
      deps.runLaunchctl.mock.invocationCallOrder[0],
    );
  });

  it("surfaces launch failures to the caller", () => {
    const deps = dependencies("<string>lastcode-checkpoint-supervisor.mjs</string>");
    deps.runLaunchctl.mockImplementation(() => {
      throw new Error("Service is not loaded");
    });
    expect(() => requestCheckpointServiceRunNow({ homeDirectory, uid: 501 }, deps)).toThrow(
      "Service is not loaded",
    );
  });

  it("retains a daily schedule for automatic post-merge requests", () => {
    const deps = dependencies("<string>lastcode-checkpoint-schedule.mjs</string>");
    expect(
      requestCheckpointServiceRunNow({ homeDirectory, uid: 501, deferDaily: true }, deps),
    ).toEqual({ status: "deferred" });
    expect(deps.writeRequest).not.toHaveBeenCalled();
    expect(deps.runLaunchctl).not.toHaveBeenCalled();
  });
});
