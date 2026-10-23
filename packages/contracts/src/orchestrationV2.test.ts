import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2Command } from "./orchestrationV2.ts";

const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);

it("preserves native-only steering as a distinct wire command", () => {
  const command = decodeOrchestrationV2Command({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "server",
    commandId: "cooperative-pause",
    threadId: "thread-1",
    messageId: "pause-message",
    text: "Pause after the current tool finishes.",
    attachments: [],
    dispatchMode: { type: "steer_active_native", targetRunId: "run-1" },
  });
  expect(command.type).toBe("message.dispatch");
  if (command.type === "message.dispatch") {
    expect(command.dispatchMode).toEqual({ type: "steer_active_native", targetRunId: "run-1" });
  }
});

const decodeClientWorkspaceCompletion = Schema.decodeUnknownExit(OrchestrationV2Command);

it("keeps accepted workspace completions outside client dispatch commands", () => {
  const completion = {
    type: "thread.workspace.complete",
    commandId: "workspace-completion",
    threadId: "workspace-thread",
    requestId: "accepted-preparation",
    runId: "preparing-run",
    expectedWorktreePath: null,
    worktreePath: "/repo-worktree",
    branch: "feature/workspace",
  };
  expect(decodeClientWorkspaceCompletion(completion)._tag).toBe("Failure");
});

it("retains a failed-attempt precondition across archive command decoding", () => {
  const archive = {
    type: "thread.archive",
    commandId: "retry-archive",
    threadId: "archive-owner",
    childDisposition: "stop_and_archive",
    expectedChildThreadIds: ["archive-participant"],
    expectedArchiveCommandId: "observed-failed-archive",
  };
  expect(decodeOrchestrationV2Command(archive)).toEqual(archive);
});
