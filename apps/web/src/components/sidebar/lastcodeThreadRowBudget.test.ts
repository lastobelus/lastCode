// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { THREAD_SIDEBAR_MIN_WIDTH } from "../threadSidebarWidth";
import { LASTCODE_THREAD_LEADING_MIN_WIDTH } from "./LastCodeThreadTitle";

// Budget constraints for the flex inputs, not a substitute for native geometry.
// The fixed metadata tracks occupy 80 physical pixels; indentation scales.
const cases = [208, 256, 901].flatMap((width) =>
  [50, 75, 100].flatMap((scale) => [0, 4, 6].map((depth) => ({ width, scale, depth }))),
);
const availableRow = ({ width, scale, depth }: (typeof cases)[number]) =>
  width - 17 - (12 + depth * 12) * (scale / 100);

describe("supported sidebar row budgets", () => {
  it.each(cases)(
    "fits the title and outcome before wrapping metadata at $width/$scale/depth$depth",
    (value) => {
      const ratio = value.scale / 100;
      // Disclosure, one row gap and end padding beside the reserved leading column.
      const firstLineMinimum = LASTCODE_THREAD_LEADING_MIN_WIDTH + (16 + 4 + 8) * ratio;
      expect(value.width).toBeGreaterThanOrEqual(THREAD_SIDEBAR_MIN_WIDTH);
      expect(availableRow(value)).toBeGreaterThanOrEqual(firstLineMinimum);
      expect(availableRow(value)).toBeGreaterThanOrEqual(80 + 8 * ratio);
    },
  );
  it.each([50, 75, 100])("reserves a readable name with both outcome and PR at %s%%", (scale) => {
    const chrome = 14 + 12 + 2 * 6 * (scale / 100);
    expect(LASTCODE_THREAD_LEADING_MIN_WIDTH - chrome).toBeGreaterThanOrEqual(32);
  });
  it.each([4, 6])("requires a separate metadata line at minimum width/depth%s", (depth) => {
    const value = { width: THREAD_SIDEBAR_MIN_WIDTH, scale: 100, depth };
    const singleLineMinimum = LASTCODE_THREAD_LEADING_MIN_WIDTH + 80 + 16 + 2 * 4 + 8;
    expect(availableRow(value)).toBeLessThan(singleLineMinimum);
  });
  it("keeps the roomy row within one line even at the deepest indentation", () => {
    const singleLineMinimum = LASTCODE_THREAD_LEADING_MIN_WIDTH + 80 + 16 + 2 * 4 + 8;
    expect(availableRow({ width: 901, scale: 100, depth: 6 })).toBeGreaterThan(singleLineMinimum);
  });
});
