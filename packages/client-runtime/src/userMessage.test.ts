import { describe, expect, it } from "vite-plus/test";

import { GuestMessageId } from "@t3tools/contracts";

import { resolveIncomingMessagePreview, resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("shows a guest's own words and name, not the attributed text the agent reads", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "user",
        text: "Message from guest Sam, sent by the owner:\n\nWhy?",
        context: {
          guest: {
            guestMessageId: GuestMessageId.make("guest-message:one"),
            name: "Sam",
            text: "Why?",
          },
        },
      }),
    ).toEqual({ text: "Why?", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});

describe("resolveIncomingMessagePreview", () => {
  it("uses a generated preview only for messages with known incoming attribution", () => {
    const message = {
      role: "user",
      createdBy: "agent" as const,
      text: "The build needs review.\nPreserve the release workflow.",
      incomingSummary: {
        status: "ready" as const,
        text: "Review build; preserve release workflow",
      },
    };
    expect(resolveIncomingMessagePreview(message)).toEqual({
      isIncoming: true,
      previewText: "Review build; preserve release workflow",
      pending: false,
      isSummary: true,
      canExpand: true,
    });
    expect(resolveIncomingMessagePreview({ ...message, createdBy: "user" })).toMatchObject({
      isIncoming: false,
      previewText: "The build needs review.",
      pending: false,
      isSummary: false,
    });
    expect(resolveIncomingMessagePreview({ ...message, role: "assistant" }).isIncoming).toBe(false);
    expect(
      resolveIncomingMessagePreview({ ...message, notification: { summary: "Native summary" } })
        .isIncoming,
    ).toBe(false);
  });

  it("keeps the original available during generation and after a failure", () => {
    const message = {
      role: "user",
      createdBy: "agent" as const,
      text: "Review the full release workflow before publishing anything. ".repeat(3),
    };
    expect(
      resolveIncomingMessagePreview({ ...message, incomingSummary: { status: "pending" } }),
    ).toMatchObject({
      previewText: message.text,
      pending: true,
      isSummary: false,
      canExpand: true,
    });
    expect(
      resolveIncomingMessagePreview({ ...message, incomingSummary: { status: "failed" } }),
    ).toMatchObject({
      previewText: message.text,
      pending: false,
      isSummary: false,
      canExpand: true,
    });
    expect(
      resolveIncomingMessagePreview({ ...message, text: "Review the release workflow" }).canExpand,
    ).toBe(false);
  });

  it("does not treat JSON content as sender metadata", () => {
    expect(
      resolveIncomingMessagePreview({ role: "user", text: '{"sender":"agent","subject":"Review"}' })
        .isIncoming,
    ).toBe(false);
  });

  it("keeps legacy automation attribution and removes its boilerplate preview", () => {
    expect(
      resolveIncomingMessagePreview({
        role: "user",
        createdBy: "agent",
        text: "[Triggered by schedule task: Build audit]\n\nReview the build.\nThen report failures.",
      }),
    ).toMatchObject({
      isIncoming: true,
      previewText: "Review the build.",
      pending: false,
      canExpand: true,
    });
  });
});
