import { describe, expect, it } from "vite-plus/test";

import {
  compareLastCodeBuilds,
  formatLastCodeVersion,
  parseLastCodeVersion,
} from "./lastcodeVersionLabel.ts";

describe("LastCode checkpoint labels", () => {
  it("formats checkpoint versions and leaves ordinary versions intact", () => {
    expect(formatLastCodeVersion("0.0.1-nightly.20261120.4979.1")).toBe("2026-11-20 • 4979.1");
    expect(formatLastCodeVersion("0.0.1-nightly.20261120.4979")).toBe("2026-11-20 • 4979");
    expect(parseLastCodeVersion("0.0.1-nightly.20261120.4979")?.key).toBe("20261120.4979.0");
    for (const version of ["0.0.1", "0.0.1-pre.20261120.4979", "0.0.1-nightly.20261120.4979.x"]) {
      expect(parseLastCodeVersion(version)).toBeNull();
      expect(formatLastCodeVersion(version)).toBe(version);
    }
  });

  it("orders date, checkpoint, and revision numerically", () => {
    const builds = [
      "20261120.4979",
      "20261120.4979.2",
      "20261120.4979.10",
      "20261120.4980",
      "20261121.1",
    ].map((key) => parseLastCodeVersion(`0.0.1-nightly.${key}`)!);
    for (const [index, build] of builds.entries()) {
      expect(compareLastCodeBuilds(build, build)).toBe(0);
      const next = builds[index + 1];
      if (next !== undefined) {
        expect(compareLastCodeBuilds(build, next)).toBeLessThan(0);
        expect(compareLastCodeBuilds(next, build)).toBeGreaterThan(0);
      }
    }
  });
});
