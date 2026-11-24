import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createNativeBrowserLifetime, NATIVE_BROWSER_IDLE_MS } from "./NativeBrowserLifetime.ts";

const schedule = (delayMs: number, task: () => void) => {
  // @effect-diagnostics-next-line globalTimers:off -- Exercises the pure policy with Vitest's fake clock.
  const timer = setTimeout(task, delayMs);
  return () => clearTimeout(timer);
};

afterEach(() => vi.useRealTimers());

describe("native browser lifetime", () => {
  it("keeps restored tabs dormant until demanded, preserves warm DOM for 24 hours, then restores on demand", async () => {
    vi.useFakeTimers();
    let mounted: ReadonlySet<string> = new Set();
    const lifetime = createNativeBrowserLifetime({ changed: (next) => (mounted = next), schedule });
    const sessions = new Set(["one", "two"]);
    lifetime.update(sessions, new Set());
    expect([...mounted]).toEqual([]);
    lifetime.update(sessions, new Set(["one"]));
    lifetime.update(sessions, new Set());
    await vi.advanceTimersByTimeAsync(NATIVE_BROWSER_IDLE_MS - 1);
    expect([...mounted]).toEqual(["one"]);
    await vi.advanceTimersByTimeAsync(1);
    expect([...mounted]).toEqual([]);
    lifetime.update(sessions, new Set(["one"]));
    expect([...mounted]).toEqual(["one"]);
    lifetime.dispose();
  });

  it("evicts the least recently used inactive page while protecting viewers and activity", async () => {
    vi.useFakeTimers();
    let mounted: ReadonlySet<string> = new Set();
    const lifetime = createNativeBrowserLifetime({
      changed: (next) => (mounted = next),
      capacity: 2,
      schedule,
    });
    const sessions = new Set(["one", "two", "three"]);
    lifetime.update(sessions, new Set(["one"]));
    lifetime.update(sessions, new Set(["two"]));
    await vi.advanceTimersByTimeAsync(1);
    lifetime.update(sessions, new Set(["three"]));
    expect([...mounted]).toEqual(["two", "three"]);
    lifetime.update(sessions, sessions);
    expect(mounted.size).toBe(2);
    expect(lifetime.reserve("one")).toBe(false);
    await vi.advanceTimersByTimeAsync(NATIVE_BROWSER_IDLE_MS * 2);
    expect(mounted.size).toBe(2);
    lifetime.update(new Set(["two"]), new Set());
    expect([...mounted]).toEqual(["two"]);
    lifetime.dispose();
  });
});
