import type { CheckpointRunRecord } from "./lastcode-checkpoint-history.ts";

export interface CheckpointEpisodeRecord {
  readonly schemaVersion: 1;
  readonly status: "episode";
  readonly episodeKey: string;
  readonly upstreamTag: string;
  readonly collectedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly windows: ReadonlyArray<{ readonly startedAt: string; readonly finishedAt: string }>;
  readonly coordinatorThreadId: string | null;
  readonly attempts: ReadonlyArray<{
    readonly attemptOrdinal: number;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly status: "success" | "failed";
    readonly checkpointTag: string | null;
    readonly failingSteps: ReadonlyArray<string> | null;
    readonly replayStops: CheckpointRunRecord["replayStops"] | null;
  }>;
  readonly alerts: ReadonlyArray<{
    readonly openedAt: string;
    readonly status: string;
    readonly attemptedAt: string | null;
    readonly deliveredAt: string | null;
  }>;
  readonly effort:
    | { readonly status: "missing"; readonly reason: string }
    | {
        readonly status: "complete" | "partial";
        readonly attribution: "whole-provider-turns-overlapping-episode";
        readonly agentTurns: number;
        readonly inputTokens: number;
        readonly cachedInputTokens: number;
        readonly outputTokens: number;
        readonly otherInputTokens: number;
        readonly otherOutputTokens: number;
        readonly threadIds: ReadonlyArray<string>;
        readonly runs: ReadonlyArray<{
          readonly threadId: string;
          readonly runId: string | null;
          readonly providerTurnIds: ReadonlyArray<string>;
        }>;
        readonly missingUsageTurnIds: ReadonlyArray<string>;
        readonly coverageMissing: ReadonlyArray<string>;
        readonly boundaryTurnIds: ReadonlyArray<string>;
      };
  readonly timing: {
    readonly firstAgentTurnAt: string | null;
    readonly installableBuildReadyAt: string | null;
    readonly revisionNeeded: boolean | null;
    readonly authorizations: ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly kind: string;
      readonly createdAt: string;
      readonly resolvedAt: string | null;
      readonly status: string;
      readonly decision?: string;
    }> | null;
    readonly ownerInterruptions: number | null;
    readonly coverageMissing?: ReadonlyArray<string>;
    readonly ownerInterruptionsDefinition?: "owner-web-mobile-messages";
    readonly ownerMessages?: ReadonlyArray<{
      readonly id: string;
      readonly threadId: string;
      readonly createdAt: string;
    }>;
  };
}

export interface CheckpointBuildReadyRecord {
  readonly schemaVersion: 1;
  readonly status: "build-ready";
  readonly episodeKey: string;
  readonly checkpointTag: string;
  readonly readyAt: string;
}

export function recordInstallableBuildReady(build: {
  readonly upstreamTag: string;
  readonly checkpointTag: string;
  readonly builtAt: string;
}): void;
