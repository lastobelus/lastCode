import { expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import { isAutomaticWakeMessage } from "./NotificationMailbox.ts";

it("identifies server restart and usage-limit follow-ups without classifying manual prompts", () => {
  const manual = {
    id: MessageId.make("manual-prompt"),
    createdBy: "user" as const,
    creationSource: "server" as const,
  };
  expect(isAutomaticWakeMessage(manual)).toBe(false);
  expect(
    isAutomaticWakeMessage({
      ...manual,
      id: MessageId.make("message:restart-continuation:source"),
    }),
  ).toBe(true);
  expect(
    isAutomaticWakeMessage({ ...manual, id: MessageId.make("limit-resume:source:request") }),
  ).toBe(true);
  expect(
    isAutomaticWakeMessage({
      ...manual,
      createdBy: "agent",
      restartContinuationOfRunId: RunId.make("restart-source"),
    }),
  ).toBe(true);
  expect(
    isAutomaticWakeMessage({
      ...manual,
      usageLimitContinuationOfRunId: RunId.make("usage-limit-source"),
    }),
  ).toBe(true);
  expect(
    isAutomaticWakeMessage({
      ...manual,
      id: MessageId.make("environment-pause:session:thread:pause:0"),
      createdBy: "system",
    }),
  ).toBe(false);
});
