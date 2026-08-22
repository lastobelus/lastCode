import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { runThreadAnnotationBodySave } from "./ThreadAnnotation";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("annotation-test-environment"),
  ThreadId.make("annotation-test-thread"),
);

describe("runThreadAnnotationBodySave", () => {
  it("serializes complete-body saves for the same thread", async () => {
    let releaseFirst: () => void = () => {};
    const firstSave = runThreadAnnotationBodySave(
      THREAD_REF,
      () =>
        new Promise<boolean>((resolve) => {
          releaseFirst = () => resolve(true);
        }),
    );
    const overlappingSave = vi.fn(async () => true);

    await expect(runThreadAnnotationBodySave(THREAD_REF, overlappingSave)).resolves.toBe(false);
    expect(overlappingSave).not.toHaveBeenCalled();

    releaseFirst();
    await expect(firstSave).resolves.toBe(true);
    await expect(runThreadAnnotationBodySave(THREAD_REF, overlappingSave)).resolves.toBe(true);
    expect(overlappingSave).toHaveBeenCalledOnce();
  });

  it("releases the thread after a failed save", async () => {
    await expect(
      runThreadAnnotationBodySave(THREAD_REF, async () => {
        throw new Error("save failed");
      }),
    ).rejects.toThrow("save failed");

    await expect(runThreadAnnotationBodySave(THREAD_REF, async () => true)).resolves.toBe(true);
  });
});
