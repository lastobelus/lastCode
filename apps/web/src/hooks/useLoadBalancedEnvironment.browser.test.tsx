import { act, render, fakeTimers } from "../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";

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

function Probe({
  onValue,
}: {
  onValue: (value: ReturnType<typeof useLoadBalancedEnvironment>) => void;
}) {
  const value = useLoadBalancedEnvironment(environmentIds, weights);
  useLayoutEffect(() => {
    onValue(value);
  });
  return null;
}

function setup() {
  const registry = AtomRegistry.make();
  telemetry.failed = false;
  let observed: ReturnType<typeof useLoadBalancedEnvironment> | undefined;
  const observe = (value: NonNullable<typeof observed>) => {
    observed = value;
  };
  return {
    get observed() {
      return observed;
    },
    view: () => (
      <RegistryContext.Provider value={registry}>
        <Probe onValue={observe} />
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]() {
      registry.dispose();
    },
  };
}

it("rejects an expired sample when telemetry and weights stay unchanged", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(100_000);
  using fixture = setup();
  await using _screen = await render(fixture.view());
  expect(fixture.observed?.environmentId).toBe("managed-server");
  expect(fixture.observed?.decision.candidates[0]).toMatchObject({
    score: 160,
    sampleAgeMs: 0,
    reason: null,
  });

  await act(() => vi.advanceTimersByTimeAsync(15_001));
  expect(fixture.observed?.pending).toBe(false);
  expect(fixture.observed?.environmentId).toBeNull();
  expect(fixture.observed?.decision.candidates[0]).toMatchObject({
    score: null,
    sampleAgeMs: 15_001,
    reason: "stale-resources",
  });
});

it("explains a failed resource request without inventing a receipt time or sample age", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(100_000);
  using fixture = setup();
  telemetry.failed = true;
  await using _screen = await render(fixture.view());
  expect(fixture.observed?.environmentId).toBeNull();
  expect(fixture.observed?.pending).toBe(false);
  expect(fixture.observed?.failed).toBe(true);
  expect(fixture.observed?.decision.candidates[0]).toMatchObject({
    resources: null,
    receivedAt: null,
    sampleAgeMs: null,
    score: null,
    reason: "resources-request-failed",
  });
});
