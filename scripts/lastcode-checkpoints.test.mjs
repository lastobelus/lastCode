import { describe, expect, it } from "vite-plus/test";

import { formatDuration, parseOptions, parseTrailers } from "./lastcode-checkpoints.mjs";

describe("LastCode checkpoint dashboard", () => {
  it("shows eight entries by default and accepts a count override", () => {
    expect(parseOptions([]).count).toBe(8);
    expect(parseOptions(["-n", "12"]).count).toBe(12);
    expect(() => parseOptions(["-n", "0"])).toThrow("Invalid checkpoint count");
  });

  it("parses checkpoint metadata trailers", () => {
    expect(parseTrailers("Title\n\nUpstream-Tag: v1-nightly.1\nDuration-Ms: 128000\n")).toEqual({
      "Upstream-Tag": "v1-nightly.1",
      "Duration-Ms": "128000",
    });
  });

  it("formats durations compactly", () => {
    expect(formatDuration(8_000)).toBe("8s");
    expect(formatDuration(188_000)).toBe("3m 08s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});
