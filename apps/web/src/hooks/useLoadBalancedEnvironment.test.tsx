import { EnvironmentId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
let renderer: ReactTestRenderer | undefined;
let observed: ReturnType<typeof useLoadBalancedEnvironment> | undefined;
let registry: AtomRegistry.AtomRegistry;

function Probe() {
  const value = useLoadBalancedEnvironment(environmentIds, weights);
  useLayoutEffect(() => {
    observed = value;
  });
  return null;
}

function TestRoot() {
  return (
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>
  );
}

beforeEach(() => {
  registry = AtomRegistry.make();
  telemetry.failed = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  observed = undefined;
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("rejects an expired sample on rerender even when telemetry and weights stay unchanged", async () => {
  await act(() => {
    renderer = create(<TestRoot />);
  });
  expect(observed?.environmentId).toBe("managed-server");
  expect(observed?.decision.candidates[0]).toMatchObject({
    score: 160,
    sampleAgeMs: 0,
    reason: null,
  });

  vi.setSystemTime(115_001);
  await act(() => renderer?.update(<TestRoot />));
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
    renderer = create(<TestRoot />);
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
