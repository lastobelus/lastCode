import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-session-identity");
const previousSession: OrchestrationSession = {
  threadId,
  status: "ready",
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex-old"),
  providerThreadId: "codex-native-old",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
};

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-session-identity"),
      title: "Session identity",
      modelSelection: { instanceId: ProviderInstanceId.make("codex-old"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: previousSession,
    },
  ],
  updatedAt: now,
};

const decideSession = (session: OrchestrationSession) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({
      command: {
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-${session.providerName}-${session.status}`),
        threadId,
        session,
        createdAt: now,
      },
      readModel,
    });
    const event = Array.isArray(decided) ? decided[0] : decided;
    if (event?.type !== "thread.session-set") throw new Error("Expected thread.session-set");
    return event.payload.session;
  });

const incoming = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId,
  status: "running",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
  ...overrides,
});

it.layer(NodeServices.layer)("thread session identity decider", (it) => {
  it.effect("preserves only omitted identity fields on the same binding", () =>
    Effect.gen(function* () {
      const sameBinding = yield* decideSession(
        incoming({ providerInstanceId: ProviderInstanceId.make("codex-old") }),
      );
      expect(sameBinding.providerThreadId).toBe("codex-native-old");

      const missingInstance = yield* decideSession(incoming());
      expect(missingInstance.providerInstanceId).toBe("codex-old");
      expect(missingInstance.providerThreadId).toBe("codex-native-old");

      const explicitlyCleared = yield* decideSession(
        incoming({
          providerInstanceId: ProviderInstanceId.make("codex-old"),
          providerThreadId: null,
        }),
      );
      expect(explicitlyCleared.providerThreadId).toBeNull();
    }),
  );

  it.effect("clears native identity when provider or provider instance changes", () =>
    Effect.gen(function* () {
      const providerChanged = yield* decideSession(
        incoming({
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claude-new"),
        }),
      );
      expect(providerChanged.providerThreadId).toBeNull();

      const instanceChanged = yield* decideSession(
        incoming({ providerInstanceId: ProviderInstanceId.make("codex-new") }),
      );
      expect(instanceChanged.providerThreadId).toBeNull();
    }),
  );
});
