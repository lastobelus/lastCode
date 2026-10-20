import { EnvironmentId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const telemetry = vi.hoisted(() => ({ failed: false }));
vi.mock("../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const success = Atom.make(
    AsyncResult.success(
      {
        sampledAt: 100_000,
        cpuUtilization: 0.2,
        cpuCount: 8,
        availableMemoryBytes: 8_000,
        totalMemoryBytes: 16_000,
      },
      { timestamp: 100_000 },
    ),
  );
  const failure = Atom.make(AsyncResult.failure(Cause.fail(new Error("Resource request failed"))));
  return {
    serverEnvironment: { hostResources: () => (telemetry.failed ? failure : success) },
  };
});

import { useLoadBalancedEnvironment } from "./useLoadBalancedEnvironment";

const environmentIds = [EnvironmentId.make("managed-server")];
const weights = { "managed-server": 50 };
let root: Root;
let observed: ReturnType<typeof useLoadBalancedEnvironment> | undefined;
let registry: AtomRegistry.AtomRegistry;

function Probe() {
  const value = useLoadBalancedEnvironment(environmentIds, weights);
  useLayoutEffect(() => {
    observed = value;
  });
  return null;
}

function testRoot() {
  return (
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>
  );
}

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  registry = AtomRegistry.make();
  telemetry.failed = false;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(100_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => root.unmount());
  observed = undefined;
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("rejects an expired sample when telemetry and weights stay unchanged", async () => {
  await act(() => {
    root.render(testRoot());
  });
  expect(observed?.environmentId).toBe("managed-server");
  expect(observed?.decision.candidates[0]).toMatchObject({
    score: 160,
    sampleAgeMs: 0,
    reason: null,
  });

  await act(() => vi.advanceTimersByTimeAsync(15_001));
  expect(observed?.pending).toBe(false);
  expect(observed?.environmentId).toBeNull();
  expect(observed?.decision.candidates[0]).toMatchObject({
    score: null,
    sampleAgeMs: 15_001,
    reason: "stale-resources",
  });
});

it("explains a failed resource request without inventing a receipt time or sample age", async () => {
  telemetry.failed = true;
  await act(() => {
    root.render(testRoot());
  });
  expect(observed?.environmentId).toBeNull();
  expect(observed?.pending).toBe(false);
  expect(observed?.failed).toBe(true);
  expect(observed?.decision.candidates[0]).toMatchObject({
    resources: null,
    receivedAt: null,
    sampleAgeMs: null,
    score: null,
    reason: "resources-request-failed",
  });
});
