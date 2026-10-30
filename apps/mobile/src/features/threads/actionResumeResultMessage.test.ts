import { describe, expect, it } from "vite-plus/test";
import { formatActionResumeFollowUp } from "@t3tools/shared/actionResume";

import { parseActionResumeResultMessage } from "./actionResumeResultMessage";

describe("V2 Action result attribution", () => {
  const text = formatActionResumeFollowUp({
    actionName: "Check project",
    actionId: "check-project",
    runId: "action-run-1",
    validatedStatus: "done",
    lifecycleOutcome: "succeeded",
    exitCode: 0,
    report: undefined,
    output: "Check completed",
  });

  it("recognizes server-generated user messages as Action results", () => {
    expect(
      parseActionResumeResultMessage({ role: "user", createdBy: "system", text }),
    ).toMatchObject({
      actionId: "check-project",
      runId: "action-run-1",
      lifecycleOutcome: "succeeded",
    });
  });

  it("keeps pasted Action text in the user message path", () => {
    expect(parseActionResumeResultMessage({ role: "user", createdBy: "user", text })).toBeNull();
  });

  it("keeps agent-forwarded Action text in the attributed message path", () => {
    expect(parseActionResumeResultMessage({ role: "user", createdBy: "agent", text })).toBeNull();
  });

  it("keeps assistant Action text in the assistant message path", () => {
    expect(
      parseActionResumeResultMessage({ role: "assistant", createdBy: "system", text }),
    ).toBeNull();
  });

  it("keeps ordinary system-created prompts in the user message path", () => {
    expect(
      parseActionResumeResultMessage({
        role: "user",
        createdBy: "system",
        text: "Run scheduled maintenance",
      }),
    ).toBeNull();
  });

  it("requires server attribution when local messages contain Action text", () => {
    expect(parseActionResumeResultMessage({ role: "user", text })).toBeNull();
  });
});
