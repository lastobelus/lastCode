export interface CiStepResult {
  readonly label: string;
  readonly status: "passed" | "failed" | "blocked";
  readonly error?: string;
  readonly blockedBy?: ReadonlyArray<string>;
  readonly durationMs: number;
}

export async function runCollectedCiSteps<
  Step extends { readonly label: string; readonly dependsOn?: ReadonlyArray<string> },
>(input: {
  readonly steps: ReadonlyArray<Step>;
  readonly signal: AbortSignal;
  readonly execute: (step: Step, index: number) => Promise<void>;
  readonly isCheckFailure: (error: unknown) => boolean;
  readonly onResult?: (result: CiStepResult) => void;
}): Promise<ReadonlyArray<CiStepResult>> {
  input.signal.throwIfAborted();
  const labels = new Set<string>();
  for (const step of input.steps) {
    if (labels.has(step.label)) throw new Error(`Duplicate CI step label: ${step.label}`);
    labels.add(step.label);
  }
  const results: CiStepResult[] = [];
  const completed = new Map<string, CiStepResult>();
  for (const [index, step] of input.steps.entries()) {
    input.signal.throwIfAborted();
    // An absent result includes missing or later prerequisites: neither proves fresh output.
    const blockedBy = (step.dependsOn ?? []).filter(
      (label) => completed.get(label)?.status !== "passed",
    );
    let result: CiStepResult;
    if (blockedBy.length > 0) {
      result = {
        label: step.label,
        status: "blocked",
        blockedBy,
        durationMs: 0,
      };
    } else {
      const startedAt = performance.now();
      try {
        await input.execute(step, index);
        input.signal.throwIfAborted();
        result = { label: step.label, status: "passed", durationMs: performance.now() - startedAt };
      } catch (error) {
        input.signal.throwIfAborted();
        if (!input.isCheckFailure(error)) throw error;
        result = {
          label: step.label,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          durationMs: performance.now() - startedAt,
        };
      }
    }
    results.push(result);
    completed.set(step.label, result);
    input.onResult?.(result);
  }
  input.signal.throwIfAborted();
  return results;
}
