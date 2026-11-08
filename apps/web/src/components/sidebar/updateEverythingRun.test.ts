import { serverUpdateStateAtom } from "@t3tools/client-runtime/state/server";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { serverReachedVersion, startDesktopUpdateLaunchNotice } from "./updateEverythingRun";

function stubStorage(entries: ReadonlyArray<readonly [string, string]>) {
  const store = new Map(entries);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
}

function relaunchWhileRestarting(environmentId: EnvironmentId) {
  const now = 1_800_000_000_000;
  vi.useFakeTimers({ now });
  stubStorage([
    [
      "t3code:update-everything-result:v1",
      JSON.stringify({
        savedAt: now,
        localVersion: null,
        updatedServers: 0,
        updatedProviders: 0,
        failures: [],
        handedOff: [{ environmentId, label: "Slow", targetVersion: "9.9.9", startedAt: now }],
      }),
    ],
  ]);
  return startDesktopUpdateLaunchNotice();
}

describe("startDesktopUpdateLaunchNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a server that is still restarting from looking idle after the app relaunches", async () => {
    const environmentId = EnvironmentId.make("slow-machine");
    const stop = relaunchWhileRestarting(environmentId);
    try {
      // Lets the registry run its cleanup of unobserved atoms before the UI mounts.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
        targetVersion: "9.9.9",
      });
    } finally {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      stop();
    }
  });

  it("clears the restored state when the server never comes back", async () => {
    const environmentId = EnvironmentId.make("lost-machine");
    const stateAtom = serverEnvironment.updateStateAtom(environmentId);
    const stop = relaunchWhileRestarting(environmentId);
    // Observed like the UI does, so the registry cannot reset it by dropping the atom.
    const release = appAtomRegistry.mount(stateAtom);
    try {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      expect(appAtomRegistry.get(stateAtom)).toEqual({ status: "idle" });
    } finally {
      release();
      stop();
    }
  });

  it("follows a handed-off server on every relaunch until its deadline", async () => {
    const environmentId = EnvironmentId.make("twice-relaunched");
    const stateAtom = serverEnvironment.updateStateAtom(environmentId);
    const startedAt = 1_800_000_000_000;
    // The app comes back after the 10-minute result notice has expired.
    vi.useFakeTimers({ now: startedAt + 15 * 60 * 1000 });
    stubStorage([
      [
        "t3code:update-everything-handoffs:v1",
        JSON.stringify([{ environmentId, label: "Slow", targetVersion: "9.9.9", startedAt }]),
      ],
    ]);
    const release = appAtomRegistry.mount(stateAtom);
    try {
      startDesktopUpdateLaunchNotice()();
      expect(appAtomRegistry.get(stateAtom)).toMatchObject({ status: "running" });
      appAtomRegistry.set(serverUpdateStateAtom(environmentId), { status: "idle" });

      startDesktopUpdateLaunchNotice()();
      expect(appAtomRegistry.get(stateAtom)).toMatchObject({ status: "running" });
      await vi.advanceTimersByTimeAsync(17 * 60 * 1000);
      expect(appAtomRegistry.get(stateAtom)).toEqual({ status: "idle" });
    } finally {
      release();
    }
  });
});

describe("serverReachedVersion", () => {
  it.each([
    ["1.2.4", "1.2.4", true],
    ["1.2.5", "1.2.4", true],
    ["1.2.3", "1.2.4", false],
    ["1.2.4-beta.1", "1.2.4", false],
    ["0.1.8-nightly.20261107.4301", "0.1.8-nightly.20261107.4301", true],
    ["0.1.8-nightly.20261106.4262", "0.1.8-nightly.20261107.4301", false],
    ["not-a-version", "1.2.4", false],
    [null, "1.2.4", false],
  ] as const)("%s reaching %s is %s", (serverVersion, targetVersion, reached) => {
    expect(serverReachedVersion(serverVersion, targetVersion)).toBe(reached);
  });
});
