import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { groupThreadDeletionTargets } from "./useWorkspaceLifecycleConfirmation";

it("keeps the complete selected owner set together within each environment", () => {
  const environmentId = EnvironmentId.make("first-environment");
  const otherEnvironment = EnvironmentId.make("second-environment");
  const first = ThreadId.make("first");
  const second = ThreadId.make("second");
  expect(
    groupThreadDeletionTargets([
      { environmentId, threadId: second },
      { environmentId: otherEnvironment, threadId: first },
      { environmentId, threadId: first },
      { environmentId, threadId: second },
    ]),
  ).toEqual([
    {
      environmentId,
      input: { operation: "delete", target: { kind: "threads", threadIds: [first, second] } },
    },
    {
      environmentId: otherEnvironment,
      input: { operation: "delete", target: { kind: "threads", threadIds: [first] } },
    },
  ]);
});
