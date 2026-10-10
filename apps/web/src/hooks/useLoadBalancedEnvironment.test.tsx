import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const telemetry = vi.hoisted(() => [
  {
    environmentId: "managed-server",
    resources: {
      sampledAt: 100_000,
      cpuUtilization: 0.2,
      cpuCount: 8,
      availableMemoryBytes: 8_000,
      totalMemoryBytes: 16_000,
    },
    receivedAt: 100_000,
    pending: false,
    failed: false,
  },
]);

vi.mock("@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return {
    RegistryContext: createContext({ refresh: vi.fn() }),
    useAtomValue: () => telemetry,
  };
});
vi.mock("../state/server", () => ({
  serverEnvironment: { hostResources: vi.fn() },
}));

import { useLoadBalancedEnvironment } from "./useLoadBalancedEnvironment";

const environmentIds = [EnvironmentId.make("managed-server")];
const weights = { "managed-server": 50 };
let renderer: ReactTestRenderer | undefined;
let observed: ReturnType<typeof useLoadBalancedEnvironment> | undefined;

function Probe() {
  const value = useLoadBalancedEnvironment(environmentIds, weights);
  useLayoutEffect(() => {
    observed = value;
  });
  return null;
}

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  observed = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("rejects an expired sample on rerender even when telemetry and weights stay unchanged", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(<Probe />);
  });
  expect(observed?.environmentId).toBe("managed-server");
  expect(observed?.decision.candidates[0]).toMatchObject({
    score: 160,
    sampleAgeMs: 0,
    reason: null,
  });

  vi.setSystemTime(115_001);
  await act(() => renderer?.update(<Probe />));
  expect(observed?.pending).toBe(false);
  expect(observed?.environmentId).toBeNull();
  expect(observed?.decision.candidates[0]).toMatchObject({
    score: null,
    sampleAgeMs: 15_001,
    reason: "stale-resources",
  });
});
