export type IntelBuildTriggerResult =
  | { readonly status: "not-configured" | "disabled" }
  | { readonly status: "dispatched"; readonly tag: string; readonly commit: string }
  | {
      readonly status: "running";
      readonly tag: string;
      readonly commit: string;
      readonly runId: number;
      readonly runUrl: string;
    }
  | {
      readonly status: "failed";
      readonly tag: string;
      readonly commit: string;
      readonly error: string;
    };

export interface IntelBuildTriggerInput {
  readonly home: string;
  readonly repoRoot: string;
  readonly tag: string;
  readonly commit: string;
}

export function triggerIntelBuild(
  input: IntelBuildTriggerInput,
  overrides?: {
    readonly runCommand?: (
      repoRoot: string,
      command: string,
      args: ReadonlyArray<string>,
    ) => string;
  },
): IntelBuildTriggerResult;
