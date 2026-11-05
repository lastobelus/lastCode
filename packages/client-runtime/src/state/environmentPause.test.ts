import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { createEnvironmentPauseConnectionsAtom } from "./environmentPause.ts";
import type { EnvironmentConnectionSummary } from "./presentation.ts";

it("requires a fresh pause observation after reconnect, preserving other environments", () => {
  const environment: EnvironmentConnectionSummary = {
    environmentId: EnvironmentId.make("first"),
    environmentLabel: "First",
    displayUrl: "https://workstation.example",
    isRelayManaged: false,
    isEnabled: true,
    connectionState: "connected",
    connectionError: null,
    connectionErrorTraceId: null,
  };
  const other = { ...environment, environmentId: EnvironmentId.make("second") };
  const environments = Atom.make<readonly EnvironmentConnectionSummary[]>([environment, other]);
  const connections = createEnvironmentPauseConnectionsAtom(environments);
  const registry = AtomRegistry.make();
  using now = vi.spyOn(Date, "now").mockReturnValue(100);
  const stop = registry.subscribe(connections, () => {});
  try {
    expect(registry.get(connections).map((entry) => entry.since)).toEqual([100, 100]);
    now.mockReturnValue(200);
    registry.set(environments, [{ ...environment, connectionState: "offline" }, other]);
    expect(registry.get(connections).map((entry) => [entry.connected, entry.since])).toEqual([
      [false, 200],
      [true, 100],
    ]);
    now.mockReturnValue(300);
    registry.set(environments, [environment, other]);
    expect(registry.get(connections).map((entry) => entry.since)).toEqual([300, 100]);
    now.mockReturnValue(400);
    registry.set(environments, [{ ...environment, environmentLabel: "Renamed" }, other]);
    expect(registry.get(connections).map((entry) => entry.since)).toEqual([300, 100]);
  } finally {
    stop();
    registry.dispose();
  }
});
