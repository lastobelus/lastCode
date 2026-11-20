import { describe, expect, it } from "@effect/vitest";

import {
  parseDarwinMemoryPressure,
  parseDarwinSwapUsed,
  parseLinuxSwapUsed,
  parseLinuxTopology,
  parsePhysicalCores,
} from "./source.ts";

describe("capacity native parsing", () => {
  it("uses physical Darwin cores and deduplicates Linux hardware threads per socket", () => {
    expect(parsePhysicalCores("10\n")).toBe(10);
    for (const text of ["", "0", "-1", "8x", "1.5", "9007199254740992"])
      expect(parsePhysicalCores(text)).toBeNull();
    expect(
      parseLinuxTopology([
        { packageId: "0\n", coreId: "0\n" },
        { packageId: "0", coreId: "0" },
        { packageId: "0", coreId: "1" },
        { packageId: "1", coreId: "0" },
      ]),
    ).toBe(3);
    expect(parseLinuxTopology([])).toBeNull();
    expect(parseLinuxTopology([{ packageId: "0", coreId: "-1" }])).toBeNull();
    expect(parseLinuxTopology([{ packageId: "", coreId: "0" }])).toBeNull();
  });

  it("maps only kernel memory-pressure levels with a known meaning", () => {
    expect(["1\n", "2", "4", "0", "garbage", ""].map(parseDarwinMemoryPressure)).toEqual([
      "normal",
      "warning",
      "critical",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("parses Darwin swap units and Linux swap without substituting free memory", () => {
    expect(
      parseDarwinSwapUsed("total = 3072.00M used = 1800.50M free = 1271.50M (encrypted)"),
    ).toBe(1800.5 * 1024 ** 2);
    expect(parseDarwinSwapUsed("used = 1.25G")).toBe(1.25 * 1024 ** 3);
    expect(parseDarwinSwapUsed("used = 0.00M")).toBe(0);
    expect(parseDarwinSwapUsed("used = -1M")).toBeNull();
    expect(parseDarwinSwapUsed("permission denied")).toBeNull();
    expect(parseLinuxSwapUsed("SwapTotal: 1024 kB\nSwapFree: 256 kB\nMemAvailable: 2 kB\n")).toBe(
      768 * 1024,
    );
    expect(parseLinuxSwapUsed("SwapTotal: 0 kB\nSwapFree: 0 kB\n")).toBe(0);
    expect(parseLinuxSwapUsed("SwapTotal: 1 kB\nSwapFree: 2 kB\n")).toBeNull();
    expect(parseLinuxSwapUsed("MemAvailable: 1234 kB\n")).toBeNull();
  });
});
