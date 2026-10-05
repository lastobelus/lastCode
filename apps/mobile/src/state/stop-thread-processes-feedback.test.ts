import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import {
  beginStopThreadProcessesFeedback,
  stopThreadProcessesFeedbackAtom,
} from "./stop-thread-processes-feedback";

const feedback = () => appAtomRegistry.get(stopThreadProcessesFeedbackAtom);

describe("stop thread processes feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("shows progress immediately and keeps a fast success visible for three seconds total", () => {
    const finish = beginStopThreadProcessesFeedback("Selected thread");
    expect(feedback()).toMatchObject({ phase: "running", description: "Selected thread" });
    vi.advanceTimersByTime(500);
    finish("success");
    vi.advanceTimersByTime(2_499);
    expect(feedback().phase).toBe("success");
    vi.advanceTimersByTime(1);
    expect(feedback().phase).toBe("idle");
  });

  it("never clears pending feedback or claims success before slow shutdown completes", () => {
    const finish = beginStopThreadProcessesFeedback("Selected thread");
    vi.advanceTimersByTime(8_000);
    expect(feedback().phase).toBe("running");
    finish("success");
    vi.runOnlyPendingTimers();
    expect(feedback().phase).toBe("idle");
  });

  it("reports unsuccessful shutdown without claiming completion", () => {
    const finish = beginStopThreadProcessesFeedback("Selected thread");
    finish("error");
    expect(feedback()).toMatchObject({
      phase: "error",
      label: "Could not confirm previews and processes stopped",
    });
    vi.advanceTimersByTime(3_000);
    expect(feedback().phase).toBe("idle");
  });

  it("keeps a newer selected thread's feedback when an older request completes", () => {
    const finishFirst = beginStopThreadProcessesFeedback("First thread");
    finishFirst("success");
    vi.advanceTimersByTime(1_000);
    const finishSecond = beginStopThreadProcessesFeedback("Second thread");
    finishFirst("error");
    vi.advanceTimersByTime(3_000);
    expect(feedback()).toMatchObject({ phase: "running", description: "Second thread" });
    finishSecond("success");
    vi.runOnlyPendingTimers();
    expect(feedback().phase).toBe("idle");
  });
});
